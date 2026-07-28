import os, time, json, inspect
from daytona import Daytona, DaytonaConfig, CreateSandboxFromImageParams, Resources, SessionExecuteRequest
d = Daytona(DaytonaConfig(api_key=os.environ["DAYTONA_API_KEY"],
                          api_url=os.environ.get("DAYTONA_API_URL","https://app.daytona.io/api")))
sb = d.create(CreateSandboxFromImageParams(image="python:3.11-slim",
        resources=Resources(cpu=1, memory=1, disk=3)))
print("sandbox:", sb.id)
print("get_metrics sig       :", str(inspect.signature(sb.get_metrics)))
print("get_metrics_latest sig:", str(inspect.signature(sb.get_metrics_latest)))
sid="load"; sb.process.create_session(sid)
sb.process.execute_session_command(sid, SessionExecuteRequest(
    command="python -c \"import time;t=time.time()\nwhile time.time()-t<25: pass\"", run_async=True))
time.sleep(15)
for name in ("get_metrics_latest","get_metrics"):
    try:
        r = getattr(sb, name)()
        print(f"{name} ->", type(r).__name__, json.dumps(r, default=lambda o: getattr(o,'__dict__',str(o)))[:400])
    except Exception as e:
        print(f"{name} -> ERR {type(e).__name__}: {str(e)[:140]}")
sb.delete(); print("deleted")
