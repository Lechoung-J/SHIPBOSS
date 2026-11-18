import json
from pathlib import Path
import tempfile
import time
import unittest

from events import EventReader, apply, safe_question
from registry import activate, read
from observer_state import build_project


class NativeIntegrationTests(unittest.TestCase):
    def test_long_pm_turn_step_progress_does_not_grant_worker(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td).resolve()
            log=root/'session.jsonl'
            now=time.time()
            def event(kind, at, **data):
                return {'type':kind, 'time':int(at*1000), 'data':data}
            events=[{'type':'session','id':'pm-owner','cwd':str(root),'createdAt':int((now-3000)*1000)},
                    event('turn/start',now-2000,turn=1),
                    event('step/start',now-2,turn=1,step=10),
                    event('step/end',now-1,turn=1,step=10)]
            log.write_text('\n'.join(map(json.dumps,events)))
            activate(root,'pm-owner','pm-owner',str(log),ttl=30)
            reader=EventReader()
            project=build_project(root,reader,auto=True,now=now)
            self.assertTrue(project['actors'][0]['active'])
            self.assertFalse(any(a['active'] for a in project['actors'][1:]))
            events += [event('turn/end',now+.1,turn=1,reason='completed'),
                       event('step/start',now+.2,turn=1,step=11)]
            log.write_text('\n'.join(map(json.dumps,events)))
            project=build_project(root,reader,auto=True,now=now+1)
            self.assertFalse(any(a['active'] for a in project['actors']))
            self.assertNotEqual(project['status'],'done')

    def test_question_payload_redacts_credentials_and_local_user(self):
        text=safe_question('check apikey_example_test_123456 /Users/example/file sk-test123456')
        self.assertNotIn('apikey_example',text)
        self.assertNotIn('sk-test123456',text)
        self.assertNotIn('/Users/example',text)


if __name__=='__main__':
    unittest.main()
