const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '../settings.json');

async function updateGithub(settings) {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) return;
  
  try {
    const content = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const response = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/settings.json`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `token ${process.env.GITHUB_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: 'Update settings',
          content: Buffer.from(content).toString('base64'),
          sha: await getFileSha()
        })
      }
    );
    
    if (!response.ok) throw new Error(await response.text());
  } catch (err) {
    console.error('GitHub update failed:', err);
  }
}

async function getFileSha() {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/settings.json`,
      {
        headers: {
          'Authorization': `token ${process.env.GITHUB_TOKEN}`
        }
      }
    );
    const data = await response.json();
    return data.sha;
  } catch {
    return null;
  }
}

module.exports = { updateGithub };
