import os, time, json
from daytona import Daytona, DaytonaConfig, CreateSandboxFromImageParams, Resources, SessionExecuteRequest
d = Daytona(DaytonaConfig(api_key=os.environ["DAYTONA_API_KEY"],
                          api_url=os.environ.get("DAYTONA_API_URL","https://app.daytona.io/api")))
sb = d.create(CreateSandboxFromImageParams(image="python:3.11-slim",
        resources=Resources(cpu=1, memory=1, disk=3)))
print("sandbox:", sb.id)
sid="load"; sb.process.create_session(sid)
# burn CPU so the 5s sampler has something to report
sb.process.execute_session_command(sid, SessionExecuteRequest(
    command="python -c \"import time;t=time.time()\nwhile time.time()-t<20: pass\"", run_async=True))
def dump(label):
    try:
        if hasattr(sb,'refresh_data'): sb.refresh_data()
    except Exception as e: print("  refresh err", e)
    try:
        m = sb.get_metrics()
        d_ = {k: getattr(m,k,None) for k in ("cpu_count","cpu_used_pct","mem_used","mem_total","disk_used","timestamp")} if m else None
        print(f"  {label}: {json.dumps(d_, default=str)}")
    except Exception as e:
        print(f"  {label}: ERR {type(e).__name__} {str(e)[:90]}")
for i,w in enumerate([6,8,10]):
    time.sleep(w); dump(f"t+{sum([6,8,10][:i+1])}s")
print("attrs on sandbox:", [a for a in dir(sb) if 'metric' in a.lower() or 'info' in a.lower()])
sb.delete(); print("deleted")
