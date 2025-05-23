const fs = require('fs');
const path = require('path');
const config = require('../config');

const SETTINGS_PATH = path.join(__dirname, '../', config.github.settingsFile);

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    }
    return {};
  } catch (err) {
    console.error('❌ Error loading settings:', err.message);
    return {};
  }
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    console.log('✅ Settings saved locally');
    return true;
  } catch (err) {
    console.error('❌ Error saving settings:', err.message);
    return false;
  }
}

module.exports = {
  loadSettings,
  saveSettings
};
