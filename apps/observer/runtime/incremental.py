"""Budgeted, fixed-input native decoding; persist sanitized state only.

One tick reads <=8MiB decoded bytes and <=8MiB compressed input. A compressed
scan pins its source inode and initial byte length, so ongoing append/atomic
rewrite cannot repeatedly reset a cold scan. No raw log copy is created.
"""
import hashlib
import os
from pathlib import Path
import selectors
import subprocess
import time

CHUNK_BUDGET = 8*1024*1024


class PendingNative(ValueError):
    pass


def proof(path, offset):
    with path.open('rb') as f:
        return file_proof(f,offset)


def file_proof(f,offset):
    position=f.tell();f.seek(0);first=f.read(min(4096,offset))
    f.seek(max(0,offset-4096));last=f.read(min(4096,offset));f.seek(position)
    return hashlib.sha256(first+b'\0'+last).hexdigest()


class IncrementalNative:
    def __init__(self):self.live={}

    def close(self):
        for key in list(self.live):self._stop(key)

    def parse(self,path,identity,old,*,budget=CHUNK_BUDGET,seconds=1.5):
        from discovery import extract,MAX_LINE
        path=Path(path);st=path.stat();key=str(path)
        signature=[st.st_dev,st.st_ino,st.st_mtime_ns,st.st_size,identity.get('inheritedEventCount'),identity.get('cwd'),identity.get('isSeeded')]
        current=self.live.get(key)
        # Identity/seed changes invalidate the old input. Ordinary file growth
        # does not reset a pinned consistent snapshot before it reaches EOF.
        if current and current['signature'][4:]!=signature[4:]:self._stop(key);current=None
        checkpoint=old.get('checkpoint') if old else None
        if current is None:
            parser=None;offset=0
            if path.suffix!='.zstd' and checkpoint and checkpoint.get('identity')==signature[4:] and checkpoint.get('inode')==signature[:2] and st.st_size>=checkpoint['offset'] and proof(path,checkpoint['offset'])==checkpoint.get('proof'):
                parser=checkpoint['parser'];offset=checkpoint['offset']
            source=path.open('rb')
            current=dict(signature=signature,parser=parser,offset=offset,buffer=b'',source=source,proof=file_proof(source,st.st_size),remaining=st.st_size)
            if path.suffix=='.zstd':
                current['process']=subprocess.Popen(['zstd','-dc'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
                current['input_buffer']=b''
                os.set_blocking(current['process'].stdin.fileno(),False)
                os.set_blocking(current['process'].stdout.fileno(),False)
            else:source.seek(offset)
            self.live[key]=current
        process=current.get('process');stream=process.stdout if process else current['source']
        deadline=time.monotonic()+seconds;total=0;fed=0;rows=[];eof=False
        selector=selectors.DefaultSelector()
        if process:
            selector.register(stream,selectors.EVENT_READ,'output')
            if not process.stdin.closed:selector.register(process.stdin,selectors.EVENT_WRITE,'input')
        try:
            while total<budget and time.monotonic()<deadline:
                if process:
                    ready=selector.select(max(0,deadline-time.monotonic()))
                    if not ready:break
                    chunk=None
                    for entry,_ in ready:
                        if entry.data=='input':
                            if fed>=budget:continue
                            if not current['input_buffer'] and current['remaining']:
                                block=current['source'].read(min(65536,current['remaining']))
                                if not block:raise ValueError('compressed-snapshot-truncated')
                                current['remaining']-=len(block);current['input_buffer']=block
                            if current['input_buffer']:
                                try:n=os.write(process.stdin.fileno(),current['input_buffer'])
                                except BlockingIOError:continue
                                current['input_buffer']=current['input_buffer'][n:];fed+=n
                            if not current['remaining'] and not current['input_buffer']:
                                selector.unregister(process.stdin);process.stdin.close()
                        else:
                            try:chunk=os.read(stream.fileno(),min(65536,budget-total))
                            except BlockingIOError:continue
                    if chunk is None:continue
                else:
                    remaining=current['signature'][3]-current['offset']
                    chunk=current['source'].read(min(65536,budget-total,remaining)) if remaining else b''
                if not chunk:eof=True;break
                total+=len(chunk);current['offset']+=len(chunk);current['buffer']+=chunk
                while b'\n' in current['buffer']:
                    line,current['buffer']=current['buffer'].split(b'\n',1)
                    if len(line)>MAX_LINE:raise ValueError('line-size-limit')
                    rows.append(line)
                if len(current['buffer'])>MAX_LINE:raise ValueError('line-size-limit')
            if eof and current['buffer']:
                rows.append(current['buffer']);current['buffer']=b''
            current['parser']=extract(path,identity,raw_lines=rows,parser_state=current['parser'],finalize=False)
            if not eof:raise PendingNative('incremental-cold-scan-pending:'+str(current['offset']))
            if process and process.wait(timeout=max(.01,deadline-time.monotonic())):raise ValueError('decode-failed')
            if file_proof(current['source'],current['signature'][3])!=current['proof']:
                raise ValueError('snapshot-prefix-rewritten')
            metadata=extract(path,identity,raw_lines=[],parser_state=current['parser'])
            checkpoint=dict(snapshotSignature=current['signature'])
            if not process:
                checkpoint.update(inode=current['signature'][:2],identity=current['signature'][4:],offset=current['offset'],proof=current['proof'],parser=current['parser'])
            self._stop(key)
            return metadata,checkpoint
        except PendingNative:raise
        except Exception:self._stop(key);raise
        finally:selector.close()

    def _stop(self,key):
        value=self.live.pop(key,None)
        if not value:return
        process=value.get('process')
        if process:
            if not process.stdin.closed:process.stdin.close()
            process.stdout.close()
            if process.poll() is None:process.kill();process.wait()
        value['source'].close()
