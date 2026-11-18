"""A fresh queue request is not evidence of a fresh official session."""
from datetime import datetime
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from discovery import DiscoveryIndex
from external_journal import OfficialJournalReader,source_key,VERSION
from onboarding import external_sessions,queue_external_activation,record_external_activation
from registry import read
from test_external_journal import codex_rows,claude_rows,save,iso
import test_external_journal as journal_fixtures


class ExternalFreshnessTests(unittest.TestCase):
    setup_case=journal_fixtures.ExternalJournalTests.setup_case

    def test_new_firstload_and_show_cannot_refresh_seven_day_open_or_old_end(self):
        for harness in ('codex','claude'):
            for ended in (False,True):
                with self.subTest(harness=harness,ended=ended),tempfile.TemporaryDirectory() as td:
                    home,root,sid,now,directory,r,path=self.setup_case(td,harness)
                    producer=codex_rows if harness=='codex' else claude_rows
                    save(path,producer(root,sid,now-7*86400,ended=ended))
                    reader=OfficialJournalReader(home=home)
                    value,error=reader.read(r,now=now)
                    self.assertIsNone(error);self.assertFalse(value['sourceFresh']);self.assertLess(value['lastEventAt'],now-6*86400)
                    self.assertEqual(value['knownEnded'],ended)
                    self.assertEqual(bool(value['activity']),ended,'old terminal facts remain known idle')
                    for action in ('firstload','show'):
                        queue_external_activation(root,harness,sid,sid,directory,action=action)
                        requests=[]
                        sessions=external_sessions(directory,now=now+.1,reader=reader,requests=requests)
                        self.assertEqual(requests,[]);self.assertFalse(sessions[0]['sourceFresh'])
                    with patch('external_journal.Path.home',return_value=home):
                        state=DiscoveryIndex(home/'empty',home/'index',activation_receipts=directory).build(now=now+.1)
                    self.assertFalse(state['projects'][0]['actors'][0]['active']);self.assertEqual(state['presentation']['requests'],[])
                    if ended:
                        self.assertFalse(state['projects'][0]['actors'][0]['uncertain']);self.assertEqual(state['projects'][0]['actors'][0]['motion'],'idle')
                    else:self.assertTrue(state['projects'][0]['actors'][0]['uncertain'])

    def test_event_timestamp_ttl_boundary_and_custom_idle_seconds(self):
        clocks=(1794849914.1234562,1794849914.0,1794849914.0000002,
                1794849914.0000007,1794849914.1234567,1794849914.9999998)
        for harness in ('codex','claude'):
            for now in clocks:
                with self.subTest(harness=harness,now=now),tempfile.TemporaryDirectory() as td:
                    with patch('test_external_journal.time.time',return_value=now):
                        home,root,sid,_,directory,r,path=self.setup_case(td,harness)
                    producer=codex_rows if harness=='codex' else claude_rows
                    save(path,producer(root,sid,now))
                    # Use the timestamp actually encoded in the journal. ISO
                    # retains microseconds; the input float may be more precise.
                    event=json.loads(path.read_text().splitlines()[-1])
                    last=datetime.fromisoformat(event['timestamp'].replace('Z','+00:00')).timestamp()
                    reader=OfficialJournalReader(home=home)
                    for ttl in (300,10):
                        for age,expected in ((ttl-.001,True),(ttl,True),(ttl+.001,False)):
                            observed_at=last+age
                            if age==ttl:self.assertEqual(observed_at-last,ttl)
                            value,error=reader.read(r,now=observed_at,freshness_seconds=ttl)
                            self.assertIsNone(error);self.assertEqual(value['lastEventAt'],last)
                            self.assertEqual(value['sourceFresh'],expected,(harness,now,ttl,age))
                    with patch('external_journal.Path.home',return_value=home):
                        state=DiscoveryIndex(home/'empty',home/'index',activation_receipts=directory).build(now=last+30,idle_seconds=10)
                    self.assertFalse(state['projects'][0]['actors'][0]['active']);self.assertEqual(state['presentation']['requests'],[])

    def test_future_missing_and_header_only_timestamps_fail_closed(self):
        for harness in ('codex','claude'):
            for case in ('future','missing','header-only'):
                with self.subTest(harness=harness,case=case),tempfile.TemporaryDirectory() as td:
                    home,root,sid,now,directory,r,path=self.setup_case(td,harness)
                    producer=codex_rows if harness=='codex' else claude_rows
                    rows=producer(root,sid,now+3600 if case=='future' else now)
                    if case=='missing':
                        for row in rows:
                            if row['type']!='session_meta':row.pop('timestamp',None)
                    elif case=='header-only':rows=rows[:1] if harness=='codex' else []
                    save(path,rows)
                    with patch('external_journal.Path.home',return_value=home):
                        state=DiscoveryIndex(home/'empty',home/'index',activation_receipts=directory).build(now=now+.1)
                    self.assertEqual(state['presentation']['requests'],[]);self.assertFalse(state['projects'][0]['actors'][0]['active'])

    def test_new_mtime_and_new_receipt_do_not_refresh_old_cached_source(self):
        with tempfile.TemporaryDirectory() as td:
            home,root,sid,now,directory,r,path=self.setup_case(td);save(path,codex_rows(root,sid,now-7*86400))
            reader=OfficialJournalReader(home=home);reader.read(r,now=now)
            os.utime(path,(now,now))
            queue_external_activation(root,'codex',sid,sid,directory,action='show')
            requests=[];sessions=external_sessions(directory,now=now+.1,reader=reader,requests=requests)
            self.assertEqual(requests,[]);self.assertFalse(sessions[0]['sourceFresh'])
            self.assertEqual(sessions[0]['activity'],[])

    def test_stale_append_fresh_turn_restores_same_request_and_owner_unchanged(self):
        for harness in ('codex','claude'):
            with self.subTest(harness=harness),tempfile.TemporaryDirectory() as td:
                home,root,sid,now,directory,r,path=self.setup_case(td,harness)
                record_external_activation(root,harness,sid,sid,directory)
                queue_external_activation(root,harness,sid,sid,directory)
                original=(root/'.delegate/observer/runtime.json').read_bytes()
                producer=codex_rows if harness=='codex' else claude_rows
                save(path,producer(root,sid,now-7*86400,ended=True))
                reader=OfficialJournalReader(home=home);requests=[]
                external_sessions(directory,now=now+.1,reader=reader,requests=requests);self.assertEqual(requests,[])
                fresh=producer(root,sid,now)
                with path.open('a') as stream:
                    for row in fresh[1:] if harness=='codex' else fresh:stream.write(json.dumps(row)+'\n')
                requests=[];sessions=external_sessions(directory,now=now+.1,reader=reader,requests=requests)
                self.assertTrue(sessions[0]['sourceFresh']);self.assertEqual(len(requests),1);self.assertEqual(requests[0]['id'],r['receiptId'])
                self.assertEqual((root/'.delegate/observer/runtime.json').read_bytes(),original)
                again=[];external_sessions(directory,now=now+.2,reader=reader,requests=again)
                self.assertEqual(again[0]['id'],requests[0]['id'],'same stable ID lets main deduplicate normally')
                with patch('external_journal.Path.home',return_value=home):state=DiscoveryIndex(home/'empty',home/'index',activation_receipts=directory).build(now=now+.1)
                self.assertTrue(state['projects'][0]['actors'][0]['active']);self.assertEqual(state['projects'][0]['ownerSessionId'],sid)

    def test_old_or_incomplete_cache_recomputes_freshness_from_journal_not_receipt(self):
        with tempfile.TemporaryDirectory() as td:
            home,root,sid,now,directory,r,path=self.setup_case(td);save(path,codex_rows(root,sid,now-7*86400))
            reader=OfficialJournalReader(home=home);reader.read(r,now=now);key=source_key(r)
            for old_version in ('official-journal-v1',VERSION):
                reader.cache[key]['version']=old_version;reader.cache[key]['state'].pop('lastEventAt',None)
                reader.cache[key]['state']['lastAt']=now  # untrusted legacy/incomplete cached freshness
                value,error=reader.read(r,now=now)
                self.assertIsNone(error);self.assertFalse(value['sourceFresh']);self.assertLess(value['lastEventAt'],now-86400)
                self.assertEqual(reader.cache[key]['version'],VERSION)


if __name__=='__main__':unittest.main()
