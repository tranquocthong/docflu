# Notion Integration Setup Guide

This guide walks you through setting up DocFlu's Notion integration from scratch.

## Prerequisites

- Node.js 16 or higher
- Notion workspace (free or paid)
- Docusaurus project with markdown content

## Step 1: Create Root Page

**IMPORTANT**: You must create a root page first, then create the integration and grant it access to this page.

### 1.1 Create Documentation Page

1. In your Notion workspace, create a new page
2. Name it something like **"Documentation"** or **"Docs"**
3. This will be the root page for all your synced content

### 1.2 Get Page ID

1. Copy the page URL from your browser
2. The page ID is the string after the last `/` and before any `?`
3. Example URL: `https://notion.so/Documentation-abc123def456`
4. Page ID: `abc123def456`

**Save this Page ID** - you'll need it for the integration setup.

## Step 2: Create Notion Integration

### 2.1 Create Integration

1. Go to [Notion Integrations](https://www.notion.so/my-integrations)
2. Click **"+ New integration"**
3. Fill in the details:
   - **Name**: `DocFlu Sync` (or your preferred name)
   - **Logo**: Optional
   - **Associated workspace**: Select your workspace
   - **Type**: **MUST** select **"Internal"** (required for DocFlu)
4. Click **"Submit"**

### 2.2 Why Internal Integration is Required

**Internal Integration** is required because:
- ✅ DocFlu needs to create pages within your workspace
- ✅ Internal integrations have proper page creation permissions
- ✅ Simpler authentication and setup
- ✅ More secure (workspace-specific access)

**⚠️ IMPORTANT**: You **MUST** choose **"Internal"** integration type for DocFlu to work properly.

### 2.3 Configure Integration Capabilities

Your integration will have these capabilities by default:
- ✅ Read content
- ✅ Update content  
- ✅ Insert content
- ✅ Read user information without email addresses

### 2.4 Grant Page Access

**CRITICAL STEP**: Grant access to your root page (created in Step 1):

1. Under **"Content Capabilities"** → **"Pages"**
2. Change from **"No page access"** to **"Selected pages"**
3. Click **"Add pages"**
4. Select your root documentation page (created in Step 1.1)
5. Click **"Add pages"**

Your integration now has access to the root page and can create child pages under it.

### 2.5 Get Integration Token

1. After setup, you'll see the **"Internal Integration Token"**
2. Click **"Show"** and copy the token
3. It should start with `secret_`
4. **Keep this secure** - treat it like a password

## Step 3: Configure DocFlu

### 3.1 Initialize Project

```bash
# Navigate to your Docusaurus project
cd /path/to/your/docusaurus-project

# Initialize DocFlu
docflu init
```

### 3.2 Update Environment Variables

Edit your `.env` file and add Notion configuration:

```bash
# Notion Configuration (Required)
NOTION_API_TOKEN=secret_your-integration-token-here
NOTION_ROOT_PAGE_ID=your-root-page-id-here  # REQUIRED - manually created page

# Optional: Existing Confluence/Google Docs settings can coexist
CONFLUENCE_BASE_URL=https://your-domain.atlassian.net
GOOGLE_CLIENT_ID=your-oauth2-client-id.googleusercontent.com
```

### 3.3 Install Dependencies

```bash
# Install DocFlu with Notion support
npm install @notionhq/client

# Optional: For diagram support
npm install @mermaid-js/mermaid-cli
```

## Step 4: Test Connection

### 4.1 Dry Run Test

```bash
# Test connection without making changes
docflu sync --notion --docs --dry-run
```

Expected output:
```
🔄 Initializing Notion sync...
✓ Connected to Notion workspace
  Bot user: DocFlu Sync
✓ Notion sync initialized
🔄 Scanning for markdown files...
📁 Found 5 markdown files
```

**If you get access errors**:
```
❌ Error: Page not found or access denied
```

**Solution**:
1. Check that `NOTION_ROOT_PAGE_ID` is correct
2. Verify integration has access to the page (Step 2.4)
3. Check that you selected the correct page in integration settings

### 4.2 Test Single File

```bash
# Sync a single file first
docflu sync --notion --file docs/intro.md
```

Expected output:
```
🔄 Syncing file: docs/intro.md
📁 Creating parent page: Docs (docs)
📄 Creating content page: Introduction
✓ Created: Introduction (12 blocks)
✓ File sync completed: docs/intro.md
```

## Step 5: Understanding Sync Modes

DocFlu offers two distinct sync modes with different behaviors:

### 5.1 Single File Sync (`--file`)

**Use Case**: Quick updates, testing, or syncing specific files

```bash
# Sync single file - always creates fresh page
docflu sync --notion --file docs/intro.md
```

**Behavior**:
- 🗑️ **Fresh Page Creation**: Archives old page and creates completely new one
- ⚡ **Fast Performance**: No content clearing, direct page replacement
- 🔄 **Always Updates**: Ignores file change detection (force sync)
- 📄 **Flat Structure**: Creates page directly in root (no hierarchy)

**Output Example**:
```
🔄 Force syncing: docs/intro.md
🗑️ Deleting old page from Notion...
✓ Old page archived successfully
📄 Creating content page: Tutorial Intro
✓ Created: Tutorial Intro (43 blocks)
```

### 5.2 Docs Sync (`--docs`)

**Use Case**: Full documentation sync with hierarchy and incremental updates

```bash
# Sync all docs with hierarchy - incremental sync
docflu sync --notion --docs
```

**Behavior**:
- 🏗️ **Hierarchical Structure**: Creates directory-based page structure
- 📈 **Incremental Sync**: Only syncs changed files for performance
- 🧹 **Content Update**: Clears and updates existing pages
- 🔍 **Change Detection**: Uses file hashes to detect changes

**Output Example**:
```
📁 Found 15 markdown files
🔄 Syncing 3 files (12 skipped)
📁 Creating parent page: Tutorial Basics
📄 Creating content page: Create A Page
✓ Updated: Create A Page (25 blocks)
```

### 5.3 Choosing the Right Mode

| Scenario | Recommended Mode | Reason |
|----------|------------------|---------|
| Testing changes | `--file` | Fast, no hierarchy needed |
| Quick fixes | `--file` | Immediate fresh page |
| Full site sync | `--docs` | Hierarchy + incremental |
| Initial setup | `--docs` | Complete structure |
| Daily updates | `--docs` | Only changed files |

## Step 6: Full Sync

### 6.1 Sync All Documentation

```bash
# Sync all docs with hierarchy
docflu sync --notion --docs
```

This will:
1. Scan all markdown files in `docs/`
2. Create directory-based page hierarchy
3. Convert markdown to Notion blocks
4. Upload images and diagrams
5. Create parent-child page relationships

### 6.2 Verify Results

Check your Notion workspace:
1. Your root page should now contain child pages
2. Directory structure should be reflected as page hierarchy
3. Content should be properly formatted
4. Images and diagrams should be uploaded

## Step 7: Advanced Configuration

### 7.1 Exclude Patterns

Add patterns to exclude certain files:

```bash
# In .env file
DOCFLU_EXCLUDE_PATTERNS=*.draft.md,private/**,temp/**
```

### 7.2 Performance Tuning

```bash
# In .env file
DOCFLU_RETRY_COUNT=3          # API retry attempts
DOCFLU_CONCURRENT_UPLOADS=5   # Parallel uploads
```

### 7.3 Diagram Support

For diagram rendering, install optional dependencies:

```bash
# Mermaid diagrams
npm install @mermaid-js/mermaid-cli

# PlantUML diagrams (requires Java)
# Install PlantUML: https://plantuml.com/download
```

## Architecture Overview

DocFlu's Notion integration uses a **direct processing architecture** for optimal performance and reliability:

### Processing Pipeline

```
Markdown Content → Notion Blocks → Process Media Directly → Upload to Notion
```

### Key Components

1. **Content Conversion**: Markdown is converted directly to Notion block format
2. **Media Processing**: Images and diagrams are processed and uploaded in real-time
3. **Block Assembly**: Final blocks are assembled with all media properly embedded
4. **API Upload**: Complete blocks are uploaded to Notion via batch API calls

### Benefits

- **Simplified Architecture**: Fewer processing steps means fewer potential failure points
- **Better Performance**: Direct processing eliminates intermediate steps
- **Easier Debugging**: Clear, linear processing flow
- **More Reliable**: No complex parsing or replacement operations
- **Real Media Hosting**: Files are properly hosted in Notion

## Troubleshooting

### Common Issues

1. **"Page not found or access denied"**
   - Verify `NOTION_ROOT_PAGE_ID` is correct
   - Check integration has access to the page
   - Ensure you selected "Selected pages" in integration settings

2. **"Integration not found"**
   - Verify `NOTION_API_TOKEN` is correct
   - Check token starts with `secret_`
   - Ensure integration is created in the correct workspace

3. **"Cannot create child pages"**
   - Verify integration has "Insert content" capability
   - Check that root page allows child page creation

### Debug Mode

Enable debug logging for troubleshooting:

```bash
DEBUG=docflu:notion docflu sync --notion --file docs/intro.md
```

This will show detailed API calls and responses for debugging issues.

## Common Directory Structures

### Example 1: Docusaurus Default

```
docs/
├── intro.md
├── tutorial-basics/
│   ├── create-a-page.md
│   └── markdown-features.md
└── tutorial-extras/
    └── manage-docs-versions.md
```

**Notion Result:**
```
📄 Documentation (root)
├── 📁 Tutorial Basics
│   ├── 📄 Create A Page
│   └── 📄 Markdown Features
├── 📁 Tutorial Extras
│   └── 📄 Manage Docs Versions
└── 📄 Intro
```

### Example 2: Complex Structure

```
docs/
├── getting-started/
│   ├── installation.md
│   └── quick-start.md
├── api/
│   ├── authentication.md
│   └── endpoints/
│       ├── users.md
│       └── posts.md
└── guides/
    └── advanced-usage.md
```

**Notion Result:**
```