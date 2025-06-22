
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
 * Get all files recursively from directory
 */
const getAllFiles = (dirPath, arrayOfFiles = []) => {
  const files = readdirSync(dirPath);

  files.forEach(file => {
    const fullPath = join(dirPath, file);
    const relativePath = relative(__dirname, fullPath);
    
    // Skip excluded files/folders
    if (excludePatterns.some(pattern => relativePath.includes(pattern))) {
      return;
    }

    if (statSync(fullPath).isDirectory()) {
      arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
    } else {
      arrayOfFiles.push({
        localPath: fullPath,
        relativePath: relativePath,
        githubPath: `${config.replitFolder}/${relativePath}`
      });
    }
  });

  return arrayOfFiles;
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
const syncFileToGithub = async (fileInfo) => {
  try {
    const content = readFileSync(fileInfo.localPath, 'utf8');
    const sha = await getFileSha(fileInfo.githubPath);

    const payload = {
      message: `Sync: Update ${fileInfo.relativePath}`,
      content: Buffer.from(content).toString('base64'),
      branch: 'main'
    };

    if (sha) {
      payload.sha = sha;
    }

    await githubRequest(
      'PUT',
      `/repos/${config.githubRepo}/contents/${fileInfo.githubPath}`,
      { json: payload }
    );

    return true;
  } catch (error) {
    console.error(`❌ Failed to sync ${fileInfo.relativePath}:`, error.message);
    return false;
  }
};

/**
 * Sync all application files to GitHub replit folder
 */
export const syncAllFilesToGithub = async () => {
  // Skip if GitHub integration not configured
  if (!config.githubToken || !config.githubRepo) {
    console.log('ℹ️ Replit sync disabled - missing token or repo configuration');
    return false;
  }

  try {
    console.log('🔄 Starting full Replit files sync to GitHub...');
    
    const allFiles = getAllFiles(__dirname);
    let successCount = 0;
    let failureCount = 0;

    console.log(`📁 Found ${allFiles.length} files to sync`);

    // Sync files in batches to avoid rate limiting
    const batchSize = 5;
    for (let i = 0; i < allFiles.length; i += batchSize) {
      const batch = allFiles.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (fileInfo) => {
        const success = await syncFileToGithub(fileInfo);
        if (success) {
          console.log(`✅ Synced: ${fileInfo.relativePath}`);
          successCount++;
        } else {
          failureCount++;
        }
        return success;
      });

      await Promise.all(batchPromises);
      
      // Small delay between batches
      if (i + batchSize < allFiles.length) {
        await setTimeout(1000);
      }
    }

    console.log(`🎉 Replit sync completed: ${successCount} success, ${failureCount} failed`);
    return failureCount === 0;

  } catch (error) {
    console.error('❌ Replit sync failed:', error.message);
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
      const success = await syncFileToGithub(fileInfo);
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
