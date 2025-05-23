const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const config = require('../config');

if (!config.github.token || !config.github.repo) {
  console.log('ℹ️ GitHub integration disabled - no token/repo configured');
}

async function updateGithub(settings) {
  if (!config.github.token || !config.github.repo) return false;

  try {
    const content = fs.readFileSync(path.join(__dirname, '../', config.github.settingsFile), 'utf8');
    const sha = await getFileSha();
    
    const response = await fetch(
      `https://api.github.com/repos/${config.github.repo}/contents/${config.github.settingsFile}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `token ${config.github.token}`,
          'Accept': 'application/vnd.github.v3+json'
        },
        body: JSON.stringify({
          message: config.github.commitMessage,
          content: Buffer.from(content).toString('base64'),
          sha: sha
        })
      }
    );

    if (!response.ok) {
      throw new Error(`GitHub API responded with ${response.status}`);
    }

    console.log('✅ Settings updated on GitHub');
    return true;
  } catch (err) {
    console.error('❌ GitHub sync failed:', err.message);
    return false;
  }
}

async function getFileSha() {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${config.github.repo}/contents/${config.github.settingsFile}`,
      {
        headers: {
          'Authorization': `token ${config.github.token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      }
    );
    
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API responded with ${response.status}`);
    
    const data = await response.json();
    return data.sha;
  } catch (err) {
    console.error('❌ Error getting file SHA:', err.message);
    return null;
  }
}

module.exports = {
  updateGithub
};
