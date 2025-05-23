const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '../settings.json');

function loadSettings() {
  try {
    return fs.existsSync(SETTINGS_FILE) 
      ? JSON.parse(fs.readFileSync(SETTINGS_FILE))
      : {};
  } catch (err) {
    console.error('Error loading settings:', err);
    return {};
  }
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Error saving settings:', err);
  }
}

module.exports = { loadSettings, saveSettings };
