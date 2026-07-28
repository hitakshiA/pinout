"""Probe Modal: auth, cold start, streaming, timeout default, teardown."""
import time, modal

t0=time.time()
app = modal.App.lookup("pinout-probe", create_if_missing=True)
print(f"app lookup      : {time.time()-t0:.2f}s")

img = modal.Image.from_registry("python:3.11-slim")
t1=time.time()
sb = modal.Sandbox.create(
    app=app, image=img, cpu=1, memory=1024,
    timeout=600,        # default is 300 — long jobs die silently without this
    idle_timeout=30,
)
cold = time.time()-t1
print(f"COLD START      : {cold:.2f}s   id={sb.object_id}")

t2=time.time()
p = sb.exec("bash","-c",'for i in $(seq 1 5); do echo "tick $i $(date +%s)"; sleep 1; done')
lines=[]
for line in p.stdout:
    if line.strip(): lines.append((time.time()-t2, line.strip()))
print(f"STREAMED LINES  : {len(lines)}")
for dt,l in lines[:6]: print(f"   +{dt:5.2f}s  {l}")

t3=time.time()
sb.terminate()
print(f"TEARDOWN        : {time.time()-t3:.2f}s")
print(f"TOTAL BILLED WALL: {time.time()-t1:.2f}s")
