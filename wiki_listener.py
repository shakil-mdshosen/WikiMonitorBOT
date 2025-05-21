import json
import time
import requests
from sseclient import SSEClient
from typing import Dict, Callable, Any

EVENTSTREAM_URL = "https://stream.wikimedia.org/v2/stream/recentchange"
RECONNECT_DELAY = 5

def stream_changes(callback: Callable[[int, Dict[str, Any]], None], 
                 monitored_groups: Dict[int, Dict[str, Any]]) -> None:
    """
    Robust EventStream listener with proper error handling
    """
    print("🔄 Starting EventStream listener...")
    
    while True:
        try:
            # Create a new session for each connection attempt
            session = requests.Session()
            
            # Make the initial request
            response = session.get(
                EVENTSTREAM_URL,
                stream=True,
                headers={'Accept': 'text/event-stream'},
                timeout=30
            )
            
            # Verify the response
            if response.status_code != 200:
                print(f"⚠️ Server returned status {response.status_code}")
                response.close()
                time.sleep(RECONNECT_DELAY)
                continue
                
            # Properly initialize the SSE client with the raw response
            client = SSEClient(response.iter_content(chunk_size=None))
            print("✅ Successfully connected to EventStream")
            
            for event in client.events():
                try:
                    if event.event != "message":
                        continue
                        
                    change = json.loads(event.data)
                    wiki = change.get("wiki")
                    change_type = change.get("type", "unknown")
                    
                    # Handle log events
                    if change_type == "log":
                        change_type = change.get("log_type", change_type)
                    
                    print(f"📡 Event: {wiki} | {change_type}")
                    
                    # Check all monitored groups
                    for group_id, config in monitored_groups.items():
                        if (config.get("wiki") == wiki and 
                            change_type in config.get("events", [])):
                            print(f"➡️ Matching group {group_id}")
                            try:
                                callback(group_id, change)
                            except Exception as e:
                                print(f"⚠️ Callback failed: {e}")
                    
                except json.JSONDecodeError:
                    print("⚠️ Invalid JSON in event")
                except Exception as e:
                    print(f"⚠️ Event processing error: {e}")

        except requests.exceptions.RequestException as e:
            print(f"⚠️ Connection error: {str(e)}")
            print(f"♻️ Reconnecting in {RECONNECT_DELAY} seconds...")
            time.sleep(RECONNECT_DELAY)
            
        except KeyboardInterrupt:
            print("🛑 Shutting down...")
            raise
            
        except Exception as e:
            print(f"⚠️ Unexpected error: {str(e)}")
            print(f"♻️ Restarting in {RECONNECT_DELAY} seconds...")
            time.sleep(RECONNECT_DELAY)
