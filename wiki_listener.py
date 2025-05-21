import json
import requests
import time
import sseclient

EVENTSTREAM_URL = "https://stream.wikimedia.org/v2/stream/recentchange"

def stream_changes(callback, monitored_groups):
    print("🔄 Starting stream_changes listener...")

    while True:  # Reconnect loop to handle connection drops gracefully
        try:
            response = requests.get(EVENTSTREAM_URL, stream=True, timeout=60)
            client = sseclient.SSEClient(response.raw)  # ✅ FIXED LINE
            print("✅ Connected to Wikimedia event stream")

            for event in client.events():
                if event.event == "message":
                    try:
                        change = json.loads(event.data)
                        wiki = change.get("wiki")
                        change_type = change.get("type")

                        # Normalize log event types (e.g., block, delete)
                        if change_type == "log":
                            change_type = change.get("log_type", change_type)

                        # Debug print to check incoming changes
                        print(f"Received event: wiki={wiki}, type={change_type}")

                        for group_id, config in monitored_groups.items():
                            if (
                                config.get("wiki") == wiki and
                                change_type in config.get("events", [])
                            ):
                                print(f"➡️ Sending change to group {group_id}")
                                callback(group_id, change)

                        time.sleep(0.01)

                    except json.JSONDecodeError as e:
                        print("JSON decode error:", e)
                    except Exception as e:
                        print("Error handling event:", e)

        except requests.exceptions.RequestException as e:
            print(f"⚠️ Connection error: {e}. Reconnecting in 5 seconds...")
            time.sleep(5)
        except KeyboardInterrupt:
            print("Listener stopped by user")
            break
        except Exception as e:
            print(f"⚠️ Unexpected error: {e}. Reconnecting in 5 seconds...")
            time.sleep(5)
