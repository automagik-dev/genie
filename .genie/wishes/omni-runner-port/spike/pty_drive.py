#!/usr/bin/env python3
"""Drive an INTERACTIVE claude session in a PTY to trigger a real
PermissionRequest dialog, so we can prove the PermissionRequest hook fires
outside headless mode. Throwaway spike harness.

We DON'T type an answer into the dialog — the whole point is that the hook
holds the request and an external resolver (wait-resolve.sh) answers it.
"""
import os, sys, pty, time, select, subprocess

PROJ = sys.argv[1]
prompt = sys.argv[2]
max_seconds = int(sys.argv[3]) if len(sys.argv) > 3 else 90

argv = ["claude", "--permission-mode", "default", prompt]

captured = bytearray()
pid, fd = pty.fork()
if pid == 0:
    os.chdir(PROJ)
    os.execvp(argv[0], argv)
    os._exit(127)

start = time.time()
# Send Enter at several fixed offsets: whichever of these lands on the trust
# dialog dismisses it; the rest submit the prefilled prompt. Harmless if extra.
enter_offsets = [4, 8, 13, 20]
sent = set()
try:
    while True:
        if time.time() - start > max_seconds:
            captured += b"\n[pty_drive] MAX TIME REACHED\n"
            break
        r, _, _ = select.select([fd], [], [], 0.5)
        if fd in r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            captured += data
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        elapsed = time.time() - start
        for off in enter_offsets:
            if off not in sent and elapsed >= off:
                os.write(fd, b"\r")
                sent.add(off)
        if b"SPIKE_DONE" in captured:
            time.sleep(1)
            break
except Exception as e:
    captured += f"\n[pty_drive] EXC {e}\n".encode()
finally:
    try:
        os.write(fd, b"\x03")  # Ctrl-C
        time.sleep(0.3)
        os.write(fd, b"\x04")  # Ctrl-D
    except OSError:
        pass
    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.waitpid(pid, os.WNOHANG)
    except OSError:
        pass
