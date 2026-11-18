#!/usr/bin/env python3
"""Project runtime CLI; external execution is opt-in and never inferred as a role."""
import argparse
import json
import os
import subprocess
import sys
import uuid

from registry import activate, bind, pulse, update


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    sub = parser.add_subparsers(dest='action', required=True)
    p = sub.add_parser('activate')
    p.add_argument('--owner-session', required=True)
    p.add_argument('--context-id', required=True)
    p.add_argument('--session-file')
    p.add_argument('--ttl', type=int, default=900)
    for action in ('bind', 'run', 'register', 'launch'):
        p = sub.add_parser(action)
        for key in ('assignment', 'task', 'role', 'slot', 'policy', 'context-id', 'session-id'):
            p.add_argument('--' + key, required=True)
        for key in ('job-id', 'agent-id', 'revision', 'predecessor'):
            p.add_argument('--' + key)
        p.add_argument('--ttl', type=int)
        if action in ('register','launch'):
            p.add_argument('--owner-session', required=True)
            p.add_argument('--source', choices=['native','process','codex','claude'], default='native' if action=='register' else 'process')
        if action in ('run','launch'):
            p.add_argument('command', nargs=argparse.REMAINDER)
    p = sub.add_parser('stage')
    p.add_argument('assignment')
    p.add_argument('--phase', required=True)
    p.add_argument('command', nargs='*')
    p = sub.add_parser('phase')
    p.add_argument('assignment')
    p.add_argument('--phase', required=True)
    p.add_argument('--state', choices=['running', 'blocked', 'unknown'], default='running')
    p = sub.add_parser('finish')
    p.add_argument('assignment')
    p.add_argument('--state', choices=['completed', 'failed', 'cancelled', 'unknown'], required=True)
    p.add_argument('--exit-code', type=int)
    p = sub.add_parser('verdict')
    p.add_argument('assignment')
    p.add_argument('--verdict', choices=['PASS', 'FAIL', 'NEEDS-HUMAN'], required=True)
    p.add_argument('--revision', required=True)
    p = sub.add_parser('pulse')
    p.add_argument('payload', help='JSON; only PM waiting/working, TTL <=900')
    raw = list(sys.argv[1:] if argv is None else argv)
    separated_command = None
    if '--' in raw:
        cut = raw.index('--'); separated_command = raw[cut+1:]; raw = raw[:cut]
    args = vars(parser.parse_args(raw))
    if separated_command is not None:
        if args['action'] not in ('run', 'stage', 'launch'):
            parser.error('-- executable is supported only by run/stage')
        args['command'] = separated_command
    root, action = args.pop('root'), args.pop('action')
    if action == 'stage':
        from stage import run_stage
        return run_stage(root, args['assignment'], args['phase'], args['command'])
    if action == 'activate':
        activate(root, **args)
    elif action in ('register','launch'):
        from dispatch import register, launch
        if action == 'register':
            print(json.dumps(register(root,**args)))
        else:
            command=args.pop('command')
            return launch(root,command=command,**args)
    elif action in ('bind', 'run'):
        command = args.pop('command', None)
        if action == 'run':
            if command and command[0] == '--':
                command = command[1:]
            if not command:
                parser.error('run requires -- executable [args]')
            if args['job_id'] or args['agent_id']:
                parser.error('run owns its local wrapper job identity; use bind for external jobs')
            args['job_id'] = f'local-{os.getpid()}-{uuid.uuid4().hex}'
        assignment = bind(root, **args)
        if action == 'run':
            update(root, assignment, state='running')
            try:
                code = subprocess.call(command)  # no shell, no discovery, no persistent process manager
            except KeyboardInterrupt:
                update(root, assignment, state='cancelled', exit_code=130)
                return 130
            except OSError:
                update(root, assignment, state='failed', exit_code=127)
                return 127
            update(root, assignment, state='cancelled' if code < 0 else 'completed' if code == 0 else 'failed', exit_code=code)
            return 128 - code if code < 0 else code
    elif action == 'pulse':
        pulse(root, json.loads(args['payload']))
    else:
        assignment = args.pop('assignment')
        update(root, assignment, **args)
        from dispatch import receipt
        print(json.dumps(receipt(root,assignment,action)))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, KeyError, OSError) as exc:
        print(f'runtime: {exc}', file=sys.stderr)
        sys.exit(2)
