import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = join(__dirname, '../settings.json');

// Load settings from local file
export const loadSettings = () => {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    }
    return {};
  } catch (err) {
    console.error('❌ Error loading settings:', err.message);
    return {};
  }
};

// Save settings to local file
export const saveSettings = (settings) => {
  try {
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    console.log('✅ Settings saved locally');
    return true;
  } catch (err) {
    console.error('❌ Error saving settings:', err.message);
    return false;
  }
};
