"""Probe Daytona: auth, cold start, session streaming, metrics, teardown.
Measures the numbers the meter depends on. Costs a few tenths of a cent."""
import os, time, asyncio, json
from daytona import Daytona, DaytonaConfig, CreateSandboxFromImageParams, Resources, SessionExecuteRequest

KEY = os.environ["DAYTONA_API_KEY"]
API = os.environ.get("DAYTONA_API_URL", "https://app.daytona.io/api")

async def main():
    d = Daytona(DaytonaConfig(api_key=KEY, api_url=API))
    print("client ok")

    t0 = time.time()
    sb = d.create(CreateSandboxFromImageParams(
        image="python:3.11-slim",
        resources=Resources(cpu=1, memory=1, disk=3),
    ))
    cold = time.time() - t0
    print(f"COLD START      : {cold:.2f}s   id={sb.id}")
    print(f"state           : {getattr(sb,'state',None)}")

    sid = "probe"
    sb.process.create_session(sid)
    cmd = sb.process.execute_session_command(sid, SessionExecuteRequest(
        command='for i in $(seq 1 5); do echo "tick $i $(date +%s)"; sleep 1; done',
        run_async=True))
    print(f"cmd_id          : {cmd.cmd_id}")

    lines, t1 = [], time.time()
    def on_out(chunk):
        for l in str(chunk).splitlines():
            if l.strip(): lines.append((time.time()-t1, l.strip()))
    try:
        await asyncio.wait_for(
            sb.process.get_session_command_logs_async(sid, cmd.cmd_id, on_out, lambda e: None),
            timeout=25)
    except asyncio.TimeoutError:
        print("(log stream timed out)")
    print(f"STREAMED LINES  : {len(lines)}")
    for dt, l in lines[:6]: print(f"   +{dt:5.2f}s  {l}")

    try:
        m = sb.get_metrics()
        print("METRICS         :", json.dumps({k: getattr(m, k, None) for k in
              ("cpu_count","cpu_used_pct","mem_used","mem_total","disk_used","timestamp")}, default=str))
    except Exception as e:
        print("METRICS         : unavailable ->", type(e).__name__, str(e)[:100])

    t2 = time.time()
    sb.delete()
    print(f"TEARDOWN        : {time.time()-t2:.2f}s")
    print(f"TOTAL BILLED WALL: {time.time()-t0:.2f}s")

asyncio.run(main())
