"""Synthetic Claude metadata diagnostics, never a real model compatibility claim."""
import json
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

from external_journal import OfficialJournalReader,claude_metadata_sample,source_key
import test_external_journal as fixtures
from test_external_journal import claude_rows,save


class ClaudeDiagnosticTests(unittest.TestCase):
    def test_fixed_reasons_preserve_strict_rejection_and_do_not_echo_values(self):
        cases=[('session-missing','sessionId',None,True),('session-mismatch','sessionId','SECRET_SESSION',False),
               ('cwd-missing','cwd',None,True),('cwd-invalid','cwd','SECRET_RELATIVE',False),
               ('cwd-mismatch','cwd','/SECRET_FOREIGN',False),('sidechain-missing','isSidechain',None,True),
               ('sidechain-not-false','isSidechain',True,False),('sidechain-not-false','isSidechain',0,False),
               ('timestamp-invalid','timestamp','SECRET_CLOCK',False),('turn-id-invalid','uuid',None,False)]
        for reason,key,value,remove in cases:
            with self.subTest(reason=reason),tempfile.TemporaryDirectory() as td:
                home,root,sid,now,directory,receipt,path=fixtures.ExternalJournalTests().setup_case(td,'claude')
                rows=claude_rows(root,sid,now)
                if remove:rows[0].pop(key)
                else:rows[0][key]=value
                save(path,rows)
                reader=OfficialJournalReader(home=home)
                result,error=reader.read(receipt,now=now)
                self.assertIsNone(result)
                self.assertEqual(error,'journal-identity-invalid:claude-'+reason)
                self.assertNotIn('SECRET',json.dumps(reader.cache))
                # Cached invalid records retain their first fixed reason.
                self.assertEqual(reader.read(receipt,now=now)[1],error)
                self.assertFalse((root/'.delegate').exists())

    def test_valid_ended_and_stale_open_sources_keep_freshness_rules(self):
        with tempfile.TemporaryDirectory() as td:
            home,root,sid,now,directory,receipt,path=fixtures.ExternalJournalTests().setup_case(td,'claude')
            save(path,claude_rows(root,sid,now))
            reader=OfficialJournalReader(home=home)
            active,error=reader.read(receipt,now=now)
            self.assertIsNone(error);self.assertTrue(active['sourceFresh'])
            stale,error=reader.read(receipt,now=now+1000)
            self.assertIsNone(error);self.assertFalse(stale['sourceFresh']);self.assertEqual(stale['tools'],[])
            save(path,claude_rows(root,sid,now,ended=True))
            ended,error=reader.read(receipt,now=now+1000)
            self.assertIsNone(error);self.assertTrue(ended['knownEnded']);self.assertFalse(ended['sourceFresh'])

    def test_legacy_cache_reparses_for_precise_reason(self):
        with tempfile.TemporaryDirectory() as td:
            home,root,sid,now,directory,receipt,path=fixtures.ExternalJournalTests().setup_case(td,'claude')
            rows=claude_rows(root,sid,now);rows[0].pop('cwd');save(path,rows)
            reader=OfficialJournalReader(home=home);reader.read(receipt,now=now)
            entry=reader.cache[source_key(receipt)]
            entry['version']='official-journal-v2-event-freshness'
            entry['state'].pop('invalidReason',None)
            self.assertEqual(reader.read(receipt,now=now)[1],'journal-identity-invalid:claude-cwd-missing')

    def test_sampler_returns_only_whitelisted_relations_not_body_or_ids(self):
        with tempfile.TemporaryDirectory() as td:
            home,root,sid,now,directory,receipt,path=fixtures.ExternalJournalTests().setup_case(td,'claude')
            rows=claude_rows(root,sid,now);rows[0].pop('isSidechain');save(path,rows)
            sample=claude_metadata_sample(receipt,home=home,now=now)
            self.assertEqual(sample['status'],'complete')
            self.assertEqual(sample['rows'][0]['identityReason'],'claude-sidechain-missing')
            self.assertEqual(sample['rows'][0]['sidechain'],'missing')
            for row in sample['rows']:
                self.assertEqual(set(row),{'line','eventType','session','cwd','sidechain','parentToolUsePresent','turnIdValid','timestamp','identityReason'})
            output=json.dumps(sample)
            self.assertNotIn('SECRET',output);self.assertNotIn(sid,output);self.assertNotIn(str(root),output)
            self.assertFalse((root/'.delegate').exists())

    def test_sampler_is_bounded_and_opens_only_exact_session(self):
        with tempfile.TemporaryDirectory() as td:
            home,root,sid,now,directory,receipt,path=fixtures.ExternalJournalTests().setup_case(td,'claude')
            rows=claude_rows(root,sid,now);save(path,rows*20)
            sample=claude_metadata_sample(receipt,home=home,now=now)
            self.assertEqual(sample['status'],'sample-line-limit');self.assertEqual(len(sample['rows']),32)
            path.write_bytes(b'x'*(256*1024+1))
            self.assertEqual(claude_metadata_sample(receipt,home=home,now=now)['status'],'sample-byte-limit')
            path.write_bytes(b'{"type":"user"')
            self.assertEqual(claude_metadata_sample(receipt,home=home,now=now)['status'],'partial-line')
            other=path.with_name(str(uuid.uuid4())+'.jsonl');other.write_text('SECRET_OTHER')
            path.unlink();path.symlink_to(other)
            with patch.object(Path,'open',side_effect=AssertionError('no symlink/unrelated open')):
                self.assertEqual(claude_metadata_sample(receipt,home=home,now=now)['status'],'journal-missing')


if __name__=='__main__':unittest.main()
