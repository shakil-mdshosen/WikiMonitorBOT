import json
import requests
import time
import sseclient

# Connect to specific Wikimedia streams
EVENTSTREAM_URL = "https://stream.wikimedia.org/v2/stream/recentchange"

def stream_changes(callback, monitored_groups):
    print("🔄 Starting stream_changes listener...")

    while True:  # Reconnect loop to handle connection drops gracefully
        try:
            response = requests.get(EVENTSTREAM_URL, stream=True, timeout=60)
            client = sseclient.SSEClient(response)
            print("✅ Connected to Wikimedia event stream")

            for event in client.events():
                if event.event == "message":
                    try:
                        change = json.loads(event.data)

                        # Print full event for debugging
                        print("\n📦 Full change event:")
                        print(json.dumps(change, indent=2))

                        wiki = change.get("meta", {}).get("wiki") or change.get("wiki")
                        change_type = change.get("type")

                        # Normalize log events if needed
                        if change_type == "log":
                            change_type = change.get("log_type", change_type)

                        print(f"🔍 Filtered: wiki={wiki}, type={change_type}")

                        for group_id, config in monitored_groups.items():
                            if (
                                config.get("wiki") == wiki and
                                change_type in config.get("events", [])
                            ):
                                print(f"➡️ Sending change to group {group_id}")
                                callback(group_id, change)

                        time.sleep(0.01)  # Prevents CPU spike

                    except json.JSONDecodeError as e:
                        print("❌ JSON decode error:", e)
                    except Exception as e:
                        print("❌ Error handling event:", e)

        except requests.exceptions.RequestException as e:
            print(f"⚠️ Connection error: {e}. Reconnecting in 5 seconds...")
            time.sleep(5)
        except KeyboardInterrupt:
            print("🛑 Listener stopped by user")
            break
        except Exception as e:
            print(f"⚠️ Unexpected error: {e}. Reconnecting in 5 seconds...")
            time.sleep(5)
