import requests

EVENTSTREAM_URL = "https://stream.wikimedia.org/v2/stream/recentchange"

def stream_changes(callback, monitored_groups):
    import sseclient
    response = requests.get(EVENTSTREAM_URL, stream=True)
    client = sseclient.SSEClient(response)

    for event in client.events():
        if event.event == "message":
            try:
                change = json.loads(event.data)
                wiki = change.get("wiki")

                for group_id, config in monitored_groups.items():
                    if config["wiki"] == wiki and change["type"] in config["events"]:
                        callback(group_id, change)
            except Exception as e:
                print("Error handling event:", e)
