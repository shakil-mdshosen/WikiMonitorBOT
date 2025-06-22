import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import got from 'got';
import { setTimeout } from 'timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Configuration
const config = {
  githubToken: process.env.GITHUB_TOKEN,
  githubRepo: process.env.GITHUB_REPO,
  maxRetries: 3,
  retryDelay: 2000,
  timeout: 15000,
  replitFolder: 'replit'
};

// Files to exclude from sync
const excludePatterns = [
  'node_modules',
  '.git',
  '.replit',
  'replit.nix',
  '.config',
  'package-lock.json',
  '.gitignore',
  'generated-icon.png'
];

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
          'User-Agent': 'WikiMonitorBot-ReplitSync'
        },
        timeout: { request: config.timeout },
        ...options
      });

      return response.body ? JSON.parse(response.body) : null;
    } catch (error) {
      lastError = error;

      if (attempt < config.maxRetries) {
        const delay = config.retryDelay * attempt;
        console.warn(`⚠️ GitHub sync attempt ${attempt} failed. Retrying in ${delay}ms...`);
        await setTimeout(delay);
      }
    }
  }

  throw lastError;
};

/**
 * Get only main files from the root directory
 */
const getMainFiles = () => {
  const mainFiles = [
    'bot.js',
    'botCheck.js',
    'config.js',
    'github.js',
    'index.js',
    'notifier.js',
    'replit-sync.js',
    'settings.js',
    'settings.json',
    'package.json',
    'README.md',
    'LICENSE',
    '.replit'
  ];

  const existingFiles = [];
  mainFiles.forEach(file => {
    if (existsSync(file)) {
      existingFiles.push(file);
    }
  });

  return existingFiles;
};

/**
 * Get file SHA from GitHub
 */
const getFileSha = async (filePath) => {
  try {
    const fileInfo = await githubRequest(
      'GET',
      `/repos/${config.githubRepo}/contents/${filePath}`
    );
    return fileInfo?.sha || null;
  } catch (error) {
    if (error.response?.statusCode === 404) return null;
    throw error;
  }
};

/**
 * Upload or update a single file to GitHub
 */
const syncFileToGithub = async (filePath, content) => {
  try {
    const sha = await getFileSha(`${config.replitFolder}/${filePath}`);

    const payload = {
      message: `Sync: Update ${filePath}`,
      content: Buffer.from(content).toString('base64'),
      branch: 'main'
    };

    if (sha) {
      payload.sha = sha;
    }

    await githubRequest(
      'PUT',
      `/repos/${config.githubRepo}/contents/${config.replitFolder}/${filePath}`,
      { json: payload }
    );

    return true;
  } catch (error) {
    console.error(`❌ Failed to sync ${filePath}:`, error.message);
    return false;
  }
};

/**
 * Sync main Replit files to GitHub
 */
export const syncAllFilesToGithub = async () => {
  // Skip if GitHub integration not configured
  if (!config.githubToken || !config.githubRepo) {
    console.log('ℹ️ Replit sync disabled - missing token or repo configuration');
    return false;
  }

  try {
    console.log('🔄 Starting main Replit files sync to GitHub...');

    const files = getMainFiles();
    console.log(`📁 Found ${files.length} main files to sync`);

    let successCount = 0;
    let failureCount = 0;

    for (const filePath of files) {
      try {
        const content = readFileSync(filePath, 'utf8');
        const relativePath = relative(__dirname, filePath);


        await syncFileToGithub(relativePath, content);
        console.log(`✅ Synced: ${relativePath}`);
        successCount++;

        // Add small delay to avoid hitting rate limits
        await setTimeout(100);
      } catch (error) {
        console.error(`❌ Failed to sync ${filePath}:`, error.message);
        failureCount++;
      }
    }

    console.log(`🎉 Replit sync completed: ${successCount} success, ${failureCount} failed`);
    return failureCount === 0;
  } catch (error) {
    console.error('❌ Main files sync failed:', error.message);
    return false;
  }
};

/**
 * Sync specific files to GitHub
 */
export const syncSpecificFiles = async (filePaths) => {
  if (!config.githubToken || !config.githubRepo) {
    return false;
  }

  try {
    const filesToSync = filePaths
      .filter(filePath => existsSync(filePath))
      .filter(filePath => !excludePatterns.some(pattern => filePath.includes(pattern)))
      .map(filePath => ({
        localPath: filePath,
        relativePath: relative(__dirname, filePath),
        githubPath: `${config.replitFolder}/${relative(__dirname, filePath)}`
      }));

    if (filesToSync.length === 0) {
      return true;
    }

    console.log(`🔄 Syncing ${filesToSync.length} changed files...`);

    let successCount = 0;
    for (const fileInfo of filesToSync) {
      const success = await syncFileToGithub(fileInfo.relativePath, readFileSync(fileInfo.localPath, 'utf8'));
      if (success) {
        console.log(`✅ Updated: ${fileInfo.relativePath}`);
        successCount++;
      }
    }

    return successCount === filesToSync.length;

  } catch (error) {
    console.error('❌ File sync failed:', error.message);
    return false;
  }
};

/**
 * Initialize Replit sync - create initial folder structure
 */
export const initReplitSync = async () => {
  if (!config.githubToken || !config.githubRepo) {
    console.log('ℹ️ Replit sync not configured');
    return false;
  }

  try {
    // Check if replit folder exists
    const folderExists = await getFileSha(`${config.replitFolder}/README.md`);

    if (!folderExists) {
      // Create README in replit folder
      await githubRequest(
        'PUT',
        `/repos/${config.githubRepo}/contents/${config.replitFolder}/README.md`,
        {
          json: {
            message: 'Initialize Replit sync folder',
            content: Buffer.from(`# Replit Application Files\n\nThis folder contains a synchronized copy of the WikiMonitor Bot application files from Replit.\n\nFiles are automatically updated when changes are made in the Replit environment.\n`).toString('base64'),
            branch: 'main'
          }
        }
      );

      console.log(`📁 Created ${config.replitFolder} folder in GitHub`);
    }

    // Perform initial sync
    return await syncAllFilesToGithub();

  } catch (error) {
    console.error('❌ Failed to initialize Replit sync:', error.message);
    return false;
  }
};