import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import got from 'got';
import { setTimeout } from 'timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = join(__dirname, 'settings.json');

// Configuration with defaults
const config = {
  githubToken: process.env.GITHUB_TOKEN,
  githubRepo: process.env.GITHUB_REPO,
  maxRetries: 3,
  retryDelay: 2000,
  timeout: 10000
};

/**
 * GitHub API wrapper with retry logic
 */
const githubRequest = async (method, endpoint, options = {}) => {
  let lastError;
  
  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      const response = await got(`https://api.github.com${endpoint}`, {
        method,
        headers: {
          'Authorization': `token ${config.githubToken}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'WikiMonitorBot'
        },
        timeout: { request: config.timeout },
        ...options
      });

      return response.body ? JSON.parse(response.body) : null;
    } catch (error) {
      lastError = error;
      
      if (attempt < config.maxRetries) {
        const delay = config.retryDelay * attempt;
        console.warn(`⚠️ Attempt ${attempt} failed. Retrying in ${delay}ms...`);
        await setTimeout(delay);
      }
    }
  }

  throw lastError;
};

/**
 * Get current file SHA from GitHub
 */
const getFileSha = async () => {
  try {
    const fileInfo = await githubRequest(
      'GET',
      `/repos/${config.githubRepo}/contents/settings.json`
    );
    return fileInfo?.sha || null;
  } catch (error) {
    if (error.response?.statusCode === 404) return null;
    throw error;
  }
};

/**
 * Synchronize settings with GitHub repository
 */
export const updateGithub = async (settings) => {
  // Skip if GitHub integration not configured
  if (!config.githubToken || !config.githubRepo) {
    console.log('ℹ️ GitHub sync disabled - missing token or repo configuration');
    return false;
  }

  try {
    // Ensure local settings file exists
    if (!existsSync(SETTINGS_PATH)) {
      writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    }

    const content = readFileSync(SETTINGS_PATH, 'utf8');
    const sha = await getFileSha();

    await githubRequest(
      'PUT',
      `/repos/${config.githubRepo}/contents/settings.json`,
      {
        json: {
          message: 'Update bot settings',
          content: Buffer.from(content).toString('base64'),
          sha,
          branch: 'main'
        }
      }
    );

    console.log('✅ Settings successfully synced with GitHub');
    
    // Also sync settings.json to replit folder
    try {
      const { syncSpecificFiles } = await import('./replit-sync.js');
      await syncSpecificFiles([SETTINGS_PATH]);
    } catch (syncError) {
      console.warn('⚠️ Replit file sync failed:', syncError.message);
    }
    
    return true;
  } catch (error) {
    console.error('❌ GitHub synchronization failed:', {
      message: error.message,
      statusCode: error.response?.statusCode,
      body: error.response?.body
    });

    // Detailed error analysis
    if (error.response?.statusCode === 401) {
      console.error('🔐 Authentication failed - check your GitHub token');
    } else if (error.response?.statusCode === 403) {
      console.error('⏳ API rate limit exceeded - try again later');
    } else if (error.response?.statusCode === 404) {
      console.error('🔍 Repository not found - check GITHUB_REPO setting');
    }

    return false;
  }
};

/**
 * Initialize GitHub synchronization (optional)
 */
export const initGithubSync = async () => {
  if (!config.githubToken || !config.githubRepo) return;

  try {
    const sha = await getFileSha();
    if (sha) {
      console.log('🔗 Connected to GitHub settings repository');
      return true;
    }
    
    // Create initial settings file if doesn't exist
    if (!existsSync(SETTINGS_PATH)) {
      writeFileSync(SETTINGS_PATH, JSON.stringify({}, null, 2));
    }
    
    await updateGithub({});
    return true;
  } catch (error) {
    console.error('❌ Failed to initialize GitHub sync:', error.message);
    return false;
  }
};
