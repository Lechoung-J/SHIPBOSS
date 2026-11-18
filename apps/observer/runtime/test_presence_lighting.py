"""Fixture-only native ownership, bounded owner reads and presence lifecycle."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from discovery import DiscoveryIndex, MAX_BYTES, extract
from events import EventReader
from observer_state import build_project
from registry import activate


class PresenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.home = self.root/'dsh'
        self.now = 1800000000
        self.index = DiscoveryIndex(self.home, self.root/'index.json')

    def event(self, kind, at=None, **data):
        return dict(type=kind, time=(self.now if at is None else at)*1000, data=data)

    def save(self, sid='pm', parent=None, depth=0, events=(), seeded=False):
        path = self.home/'sessions/encoded'/sid/'session.jsonl'
        path.parent.mkdir(parents=True, exist_ok=True)
        header = dict(type='session', id=sid, cwd='/not-read/project', parentSession=parent,
                      delegationDepth=depth, isSeeded=seeded, createdAt=(self.now-2000)*1000)
        records = [header]+list(events)
        for seq,e in enumerate(records[1:]):
            e['seq'] = seq
        path.write_text('\n'.join(json.dumps(e) for e in records)+'\n')
        return path

    def usage(self):
        return self.event('user/message', source=dict(kind='skill-invocation', name='shipboss', form='instructions'))

    def project(self):
        return self.index.build(now=self.now)['projects'][0]

    def test_seeded_parent_depth_zero_is_pm_but_inherited_descriptor_is_not_own(self):
        self.save(parent='old-pm', seeded=True, events=[
            self.event('subagent/descriptor', agentId='old-worker'),
            self.event('session/end-seed', inherited=True), self.usage(),
            self.event('turn/start', turn=1)])
        p=self.project()
        self.assertTrue(p['actors'][0]['active'])
        self.assertEqual(p['actors'][0]['motion'],'working')
        self.assertFalse(p['isIdle'])

    def test_depth_one_or_own_descriptor_never_pm_even_human_question(self):
        for depth,descriptor in [(1,False),(0,True),(None,True)]:
            with self.subTest(depth=depth,descriptor=descriptor):
                self.save(depth=depth, events=([self.event('subagent/descriptor', agentId='worker')] if descriptor else [])+[
                    self.usage(), self.event('user/message', role='user', source={'kind':'user'}),
                    self.event('turn/start',turn=1), self.event('tool/call',name='ask_user_question',callId='q',arguments={'questions':[]})])
                p=self.project()
                self.assertFalse(p['actors'][0]['active'])
                self.assertFalse(p['needsAttention'])

    def test_foreign_and_explicitly_inherited_descriptors_do_not_change_pm(self):
        self.save(parent='old', events=[self.event('subagent/descriptor',source={'sessionId':'foreign'},agentId='x'),
            self.event('subagent/descriptor',inherited=True,agentId='x'),self.usage(),self.event('turn/start',turn=1)])
        self.assertTrue(self.project()['actors'][0]['active'])

    def test_fresh_native_child_waits_pm_without_worker_roles_or_question(self):
        self.save(events=[self.usage(), self.event('turn/start',self.now-10,turn=1), self.event('turn/end',self.now-8,turn=1)])
        self.save('child','pm',1,[self.event('subagent/descriptor',agentId='worker'),
            self.event('turn/start',self.now-7,turn=1), self.event('step/start',self.now-1,turn=1)])
        p=self.project()
        self.assertTrue(p['actors'][0]['active'])
        self.assertEqual(p['actors'][0]['motion'],'waiting')
        self.assertFalse(p['needsAttention'])
        self.assertFalse(any(a['active'] for a in p['actors'][1:]))
        self.assertFalse(p['isIdle'])
        self.assertNotEqual(p['status'],'done')
        # Settlement, not a timeout teleport: PM intent becomes inactive/known.
        self.save('child','pm',1,[self.event('subagent/descriptor',agentId='worker'),self.event('turn/end',turn=1)])
        p=self.project()
        self.assertFalse(p['actors'][0]['active'])
        self.assertFalse(p['actors'][0]['uncertain'])

    def test_fresh_pm_turn_wins_over_background_and_unrelated_child_is_not_callback(self):
        self.save(events=[self.usage(),self.event('turn/start',turn=1)])
        self.save('child','pm',1,[self.event('turn/start',turn=1)])
        self.assertEqual(self.project()['actors'][0]['motion'],'working')
        self.save(events=[self.usage(),self.event('turn/end',turn=1)])
        self.save('child','someone-else',1,[self.event('turn/start',turn=1)])
        p=self.project()
        self.assertFalse(p['actors'][0]['active'])
        self.assertFalse(p['actors'][0]['uncertain'])
        self.assertFalse(any(a['active'] for a in p['actors'][1:]))

    def test_matched_job_fresh_waits_but_stale_or_foreign_does_not(self):
        for age,owner,wait in [(1,'pm',True),(900,'pm',False),(1,'foreign',False)]:
            usage=self.usage();usage['time']=(self.now-1000)*1000
            self.save(events=[usage, self.event('turn/end',self.now-800,turn=1),
                self.event('job/started',self.now-age,jobId='job-1',owner=owner)])
            p=self.project()
            self.assertEqual(p['actors'][0]['active'],wait)
            if age==900:self.assertTrue(p['isIdle'],'old unsettled work is not perpetual activity')
            self.assertFalse(p['actors'][0]['uncertain'])
            self.assertFalse(any(a['active'] for a in p['actors'][1:]))

    def test_owner_between_32_and_64_mib_is_read_and_cached_by_both(self):
        path=self.save(events=[self.usage(),self.event('turn/start',turn=1)])
        # Large ignored payload; no real project logs or result content read.
        with path.open('a') as f:
            for i in range(34):
                f.write(json.dumps(dict(type='ignored',data={'padding':'x'*(1024*1024)}))+'\n')
        self.assertGreater(path.stat().st_size,32*1024*1024)
        reader=EventReader()
        self.assertTrue(any(e['type']=='turn/start' for e in reader.read(path)[0]))
        reader.read(path);self.assertEqual(reader.loads,1)
        self.assertTrue(extract(path,{})['activity'])
        self.assertEqual(MAX_BYTES,64*1024*1024)
        with patch('discovery.MAX_BYTES',128):
            with self.assertRaises(ValueError):
                EventReader().read(path)

    def test_explicit_aged_known_end_is_not_uncertain(self):
        project=self.root/'registered';project.mkdir()
        d=activate(project,'owner','owner')
        registry=project/'.delegate/observer/runtime.json'
        d=json.loads(registry.read_text());d['pm']={'state':'idle','updated_at':self.now-800,'turn':1}
        registry.write_text(json.dumps(d))
        p=build_project(project,now=self.now)
        self.assertFalse(p['actors'][0]['active'])
        self.assertFalse(p['actors'][0].get('uncertain',False))
        self.assertNotEqual(p['status'],'done')


if __name__=='__main__':
    unittest.main()
