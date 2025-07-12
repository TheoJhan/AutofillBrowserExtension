# GitHub Integration for Automation Files

This extension now supports loading automation files directly from GitHub repositories, allowing for centralized management and easy updates of automation scripts.

## 🚀 Quick Setup

### 1. Create a GitHub Repository

Create a new repository on GitHub with the following structure:
```
your-repo/
├── automation/
│   ├── example.com.json
│   ├── google.com.json
│   ├── facebook.com.json
│   └── other-sites.json
└── README.md
```

### 2. Configure the Extension

#### Option A: Using Browser Console
```javascript
// Set your GitHub configuration
window.setGitHubConfig({
  owner: 'your-github-username',
  repo: 'your-repo-name',
  branch: 'main',
  path: 'automation'
});

// Test the connection
window.testGitHub();
```

#### Option B: Using the UI (Coming Soon)
- Click on the GitHub configuration display in the extension
- Enter your repository details
- Test the connection
- Save the configuration

### 3. Automation File Format

Your automation files should follow the same JSON format as the local files:

```json
[
  {
    "action": "fill",
    "selector": "#email",
    "valueKey": "emailBox"
  },
  {
    "action": "click",
    "selector": "#submit-button"
  }
]
```

## 🔧 Configuration Options

### GitHub Configuration Object
```javascript
{
  owner: 'your-github-username',    // Required: GitHub username
  repo: 'your-repo-name',          // Required: Repository name
  branch: 'main',                  // Optional: Branch name (default: 'main')
  path: 'automation'               // Optional: Path to automation files (default: 'automation')
}
```

### File Naming Convention

The extension looks for automation files using this pattern:
1. `{domain}{path}.json` - Specific path automation
2. `{domain}.json` - General domain automation

Example for `https://example.com/register`:
1. `example.com_register.json` (specific path)
2. `example.com.json` (general domain)

## 🧪 Testing Functions

### Test GitHub Configuration
```javascript
window.testGitHub()
```

### Test Citations System
```javascript
window.testCitations()
```

### Set GitHub Configuration
```javascript
window.setGitHubConfig({
  owner: 'your-username',
  repo: 'your-repo',
  branch: 'main',
  path: 'automation'
})
```

### Reset to Default Configuration
```javascript
window.resetGitHubConfig()
```

## 🔄 How It Works

1. **Priority Loading**: The extension first tries to load from GitHub, then falls back to local files
2. **Automatic Updates**: Changes to your GitHub repository are immediately available
3. **Error Handling**: If GitHub is unavailable, local files are used as backup
4. **Caching**: Files are cached for performance but updated when needed

## 📁 Repository Structure Example

```
automation-repo/
├── automation/
│   ├── google.com.json
│   ├── facebook.com.json
│   ├── twitter.com.json
│   ├── linkedin.com.json
│   ├── github.com.json
│   └── example.com_register.json
├── README.md
└── .gitignore
```

## 🔒 Security Considerations

- **Public Repositories**: Files are loaded via GitHub's raw content URLs
- **Private Repositories**: Currently not supported (requires authentication)
- **Rate Limiting**: GitHub has rate limits for raw content access
- **CORS**: GitHub raw content is accessible from browser extensions

## 🐛 Troubleshooting

### Common Issues

1. **"GitHub file not found"**
   - Check your repository name and owner
   - Verify the file exists in the specified path
   - Ensure the branch name is correct

2. **"Connection failed"**
   - Check your internet connection
   - Verify the repository is public
   - Test the raw URL in your browser

3. **"Local files used"**
   - This is normal fallback behavior
   - Check GitHub configuration
   - Verify file naming convention

### Debug Commands

```javascript
// Check current configuration
chrome.runtime.sendMessage({action: 'getGitHubConfig'}, console.log)

// Test connection
chrome.runtime.sendMessage({action: 'testGitHubConnection'}, console.log)

// Debug automation loading
window.testGitHub()
```

## 📝 Best Practices

1. **File Organization**: Keep automation files organized by domain
2. **Version Control**: Use Git tags for stable releases
3. **Testing**: Test automation files before pushing to main branch
4. **Documentation**: Include README files in your automation folders
5. **Backup**: Keep local copies as backup

## 🔄 Migration from Local Files

1. Upload your existing automation files to GitHub
2. Configure the extension with your repository details
3. Test the connection
4. Remove local files (optional - they serve as backup)

## 📞 Support

If you encounter issues:
1. Check the browser console for error messages
2. Use the debug functions to identify problems
3. Verify your GitHub repository structure
4. Test the raw URLs manually in your browser 

---

Absolutely! To connect your extension to your GitHub repository at [TheoJhan/AutofillBrowserExtension/automation](https://github.com/TheoJhan/AutofillBrowserExtension/tree/main/automation), you just need to update the GitHub configuration in your extension to point to your repository.

Here’s how you can do it:

---

## 1. Update the GitHub Configuration

You can do this directly from the browser console using the following command:

```javascript
window.setGitHubConfig({
  owner: 'TheoJhan',
  repo: 'AutofillBrowserExtension',
  branch: 'main',
  path: 'automation'
});
```

- **owner**: `'TheoJhan'`
- **repo**: `'AutofillBrowserExtension'`
- **branch**: `'main'`
- **path**: `'automation'`

---

## 2. Test the Connection

After setting the config, you can test if the extension can access your automation files:

```javascript
window.testGitHub();
```

You should see logs in the console indicating whether the automation files were found and loaded from your GitHub repository.

---

## 3. How It Works

- The extension will now try to load automation files from:
  ```
  https://raw.githubusercontent.com/TheoJhan/AutofillBrowserExtension/main/automation/{filename}.json
  ```
- If the file is not found on GitHub, it will fall back to local files.

---

## 4. Example: File URL

If you have a file named `google.com.json` in your automation folder, the extension will fetch it from:
```
https://raw.githubusercontent.com/TheoJhan/AutofillBrowserExtension/main/automation/google.com.json
```

---

## 5. Reset to Default (if needed)

If you want to reset the GitHub configuration to the default, use:
```javascript
window.resetGitHubConfig();
```

---

## 6. Reference

- [TheoJhan/AutofillBrowserExtension/automation on GitHub](https://github.com/TheoJhan/AutofillBrowserExtension/tree/main/automation)

---

**You do not need to change any code**—just update the configuration as shown above, and your extension will use your GitHub repository for automation files! If you want to make this configurable via the UI, you can use the modal or UI component described in the previous steps.

If you need the UI to have a button or modal for this, let me know and I can help you add that as well! 