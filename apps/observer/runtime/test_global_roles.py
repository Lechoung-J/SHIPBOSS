"""Global discovery must not promote a skill-reading reviewer to PM."""
import json
from pathlib import Path
import tempfile
import time
import unittest
from discovery import DiscoveryIndex


class GlobalRoleTests(unittest.TestCase):
    def test_child_skill_use_does_not_override_idle_pm_identity(self):
        with tempfile.TemporaryDirectory() as td:
            home=Path(td)/'dsh'
            now=time.time()
            def save(sid,parent,events):
                p=home/'sessions/encoded'/sid/'session.jsonl'
                p.parent.mkdir(parents=True)
                header={'type':'session','id':sid,'cwd':'/not-read/shared-project','isSeeded':False,'parentSession':parent}
                data=[header]
                for seq,(kind,at,body) in enumerate(events):
                    data.append({'type':kind,'seq':seq,'time':at*1000,'data':body})
                p.write_text('\n'.join(json.dumps(x) for x in data)+'\n')
            activation=[('user/message',now-10,{'source':{'kind':'skill-invocation','name':'shipboss','form':'instructions'}})]
            save('pm-owner',None,activation+[
                ('turn/start',now-9,{'turn':1}),('turn/end',now-7,{'turn':1})])
            save('fresh-reviewer','pm-owner',activation+[
                ('turn/start',now-5,{'turn':1}),('step/start',now-1,{'turn':1,'step':1})])
            project=DiscoveryIndex(home,Path(td)/'index.json').build(now=now)['projects'][0]
            self.assertFalse(project['actors'][0]['active'],'A reviewer loading the protocol is not the PM')
            self.assertFalse(any(a['active'] for a in project['actors'][1:]))
            self.assertFalse(project['isIdle'],'Fresh observed work may keep the office lit without guessing its role')
            self.assertEqual(project['observation']['status'],'unknown')
            self.assertNotEqual(project['status'],'done')


if __name__=='__main__':
    unittest.main()
