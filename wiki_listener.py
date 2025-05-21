import json
import requests
import time
import sseclient

EVENTSTREAM_URL = "https://stream.wikimedia.org/v2/stream/recentchange"

def stream_changes(callback, monitored_groups):
    print("🔄 Starting stream_changes listener...")

    while True:
        try:
            response = requests.get(EVENTSTREAM_URL, stream=True, timeout=60)
            response.raise_for_status()  # ✅ Ensure we get a valid response
            client = sseclient.SSEClient(response)  # ✅ Don't use response.raw

            print("✅ Connected to Wikimedia event stream")

            for event in client.events():
                if event.event == "message":
                    try:
                        change = json.loads(event.data)
                        wiki = change.get("wiki")
                        change_type = change.get("type")

                        # Handle 'log' type events specially
                        if change_type == "log":
                            change_type = change.get("log_type", change_type)

                        print(f"📡 Change received: {wiki} | {change_type}")

                        for group_id, config in monitored_groups.items():
                            if (
                                config.get("wiki") == wiki and
                                change_type in config.get("events", [])
                            ):
                                print(f"➡️ Forwarding to group {group_id}")
                                callback(group_id, change)

                        time.sleep(0.01)

                    except json.JSONDecodeError as e:
                        print("⚠️ JSON decode error:", e)
                    except Exception as e:
                        print("⚠️ Error handling event:", e)

        except requests.exceptions.RequestException as e:
            print(f"⚠️ Connection error: {e}. Reconnecting in 5 seconds...")
            time.sleep(5)
        except Exception as e:
            print(f"⚠️ Unexpected error: {e}. Reconnecting in 5 seconds...")
            time.sleep(5)
