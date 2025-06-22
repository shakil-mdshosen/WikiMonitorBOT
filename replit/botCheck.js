/**
 * Checks if an event comes from a bot account using MediaWiki's permission system
 * @param {Object} eventData - The event data from Wikimedia EventStream
 * @returns {boolean} True if the event is from a bot account
 */
export function isBotAccount(eventData) {
  // Check performer-based bot flags (newer event format)
  if (eventData.performer) {
    if (eventData.performer.user_groups?.includes('bot') || 
        eventData.performer.user_is_bot === true) {
      return true;
    }
  }

  // Check direct bot flag (older event format)
  if (eventData.bot === true) {
    return true;
  }

  // Check user groups in recentchange events
  if (eventData.user_groups?.includes('bot')) {
    return true;
  }

  // Check log-specific bot flags
  if (eventData.log_params) {
    if (eventData.log_params.flags?.includes('bot') || 
        eventData.log_params.bot === true) {
      return true;
    }
  }

  // Check for suppressed bot edits (sometimes flagged differently)
  if (eventData.suppressed === true && eventData.type === 'edit') {
    return true;
  }

  return false;
}

// Optional: Add logging for debugging
export function logBotCheck(eventData, result) {
  const username = eventData.user || eventData.performer?.user_text || 'unknown';
  console.log(`Bot check for ${username}: ${result ? 'Bot detected' : 'Not a bot'}`);
}
