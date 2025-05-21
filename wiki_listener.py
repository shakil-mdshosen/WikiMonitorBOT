import json
import requests
import time
import sseclient
from typing import Dict, Callable, Any
from dataclasses import dataclass

EVENTSTREAM_URL = "https://stream.wikimedia.org/v2/stream/recentchange"
RECONNECT_DELAY = 5  # seconds
EVENT_PROCESSING_DELAY = 0.01  # seconds

@dataclass
class GroupConfig:
    wiki: str
    events: list[str]

def stream_changes(callback: Callable[[int, Dict[str, Any]], None], 
                  monitored_groups: Dict[int, GroupConfig]) -> None:
    """
    Continuously listens to Wikimedia event stream and forwards relevant events to registered groups.
    
    Args:
        callback: Function to call when a relevant event is found (receives group_id and change data)
        monitored_groups: Dictionary mapping group IDs to their configuration
    """
    print("🔄 Starting Wikimedia EventStream listener...")
    
    while True:
        try:
            # Initialize connection with timeout and streaming
            response = requests.get(
                EVENTSTREAM_URL,
                stream=True,
                timeout=60,
                headers={'Accept': 'text/event-stream'}
            )
            response.raise_for_status()
            
            client = sseclient.SSEClient(response)
            print("✅ Successfully connected to Wikimedia EventStream")

            for event in client.events():
                if not event.event == "message":
                    continue
                    
                try:
                    change = json.loads(event.data)
                    wiki = change.get("wiki")
                    change_type = change.get("type", "unknown")
                    
                    # Special handling for log events
                    if change_type == "log":
                        change_type = change.get("log_type", change_type)
                    
                    print(f"📡 Event received | Wiki: {wiki} | Type: {change_type}")
                    
                    # Check all monitored groups for matching criteria
                    for group_id, config in monitored_groups.items():
                        if (config.wiki == wiki and 
                            change_type in config.events):
                            print(f"➡️ Forwarding to group {group_id}")
                            try:
                                callback(group_id, change)
                            except Exception as e:
                                print(f"⚠️ Failed to send to group {group_id}: {e}")
                    
                    time.sleep(EVENT_PROCESSING_DELAY)
                
                except json.JSONDecodeError:
                    print("⚠️ Malformed event data (JSON decode failed)")
                except KeyError as e:
                    print(f"⚠️ Missing expected field in event: {e}")
                except Exception as e:
                    print(f"⚠️ Unexpected error processing event: {e}")

        except requests.exceptions.RequestException as e:
            print(f"⚠️ Connection error ({e.__class__.__name__}): {e}")
            print(f"♻️ Reconnecting in {RECONNECT_DELAY} seconds...")
            time.sleep(RECONNECT_DELAY)
            
        except KeyboardInterrupt:
            print("🛑 Received interrupt signal, shutting down...")
            raise
            
        except Exception as e:
            print(f"⚠️ Unexpected error in event loop ({e.__class__.__name__}): {e}")
            print(f"♻️ Restarting in {RECONNECT_DELAY} seconds...")
            time.sleep(RECONNECT_DELAY)
