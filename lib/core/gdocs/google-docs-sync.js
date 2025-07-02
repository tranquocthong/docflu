const chalk = require('chalk');
const ora = require('ora');
const path = require('path');
const fs = require('fs').promises;
const GoogleDocsConverter = require('./google-docs-converter');
const GoogleDocsState = require('./google-docs-state');
const DocusaurusScanner = require('../docusaurus-scanner');
const ReferenceProcessor = require('../reference-processor');

const GoogleDriveClient = require('./google-drive-client');
const GDocsImageProcessor = require('./gdocs-image-processor');
const LinkProcessor = require('./link-processor');

/**
 * Debug Helper for Google Docs Sync
 * Saves debug information to files instead of console logging
 */
class GoogleDocsSyncDebugger {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.debugDir = path.join(projectRoot, '.docusaurus', 'debug', 'gdocs-sync');
    this.isEnabled = process.env.DEBUG_GDOCS_CONVERTER === 'true';
  }

  async ensureDebugDir() {
    if (!this.isEnabled) return;
    
    try {
      await fs.mkdir(this.debugDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create debug directory:', error.message);
    }
  }

  async logDocumentStructure(document, stepName, additionalData = {}) {
    if (!this.isEnabled) return;

    await this.ensureDebugDir();
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `document-structure-${stepName}-${timestamp}.json`;
    const filepath = path.join(this.debugDir, filename);
    
    const debugData = {
      timestamp: new Date().toISOString(),
      step: stepName,
      documentId: document.documentId,
      documentStructure: this.extractDocumentStructure(document),
      ...additionalData,
      metadata: {
        converterVersion: "1.0.0",
        nodeVersion: process.version,
        debugEnabled: this.isEnabled,
        debugDir: this.debugDir,
        filename: filename
      }
    };

    try {
      await fs.writeFile(filepath, JSON.stringify(debugData, null, 2));

    } catch (error) {
      console.error('Failed to save debug file:', error.message);
    }
  }

  extractDocumentStructure(document) {
    const structure = {
      totalElements: 0,
      elements: []
    };

    if (!document.body || !document.body.content) {
      return structure;
    }

    document.body.content.forEach((element, index) => {
      const elementInfo = {
        index: index,
        startIndex: element.startIndex,
        endIndex: element.endIndex,
        type: null,
        details: {}
      };

      if (element.table) {
        elementInfo.type = 'table';
        elementInfo.details = {
          rows: element.table.rows,
          columns: element.table.columns,
          tableRows: element.table.tableRows ? element.table.tableRows.length : 0
        };

        // Extract table cell structure
        if (element.table.tableRows) {
          elementInfo.details.cellStructure = element.table.tableRows.map((row, rowIndex) => ({
            rowIndex: rowIndex,
            cells: row.tableCells ? row.tableCells.map((cell, cellIndex) => ({
              cellIndex: cellIndex,
              startIndex: cell.startIndex,
              endIndex: cell.endIndex,
              contentElements: cell.content ? cell.content.length : 0
            })) : []
          }));
        }
      } else if (element.paragraph) {
        elementInfo.type = 'paragraph';
        const text = this.extractTextFromParagraph(element.paragraph);
        elementInfo.details = {
          text: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
          textLength: text.length,
          elements: element.paragraph.elements ? element.paragraph.elements.length : 0
        };
      } else if (element.sectionBreak) {
        elementInfo.type = 'sectionBreak';
      }

      structure.elements.push(elementInfo);
      structure.totalElements++;
    });

    return structure;
  }

  extractTextFromParagraph(paragraph) {
    if (!paragraph.elements) return '';
    
    return paragraph.elements
      .filter(element => element.textRun)
      .map(element => element.textRun.content)
      .join('');
  }

  async logRequestBatch(requests, batchName, additionalData = {}) {
    if (!this.isEnabled) return;

    await this.ensureDebugDir();
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `request-batch-${batchName}-${timestamp}.json`;
    const filepath = path.join(this.debugDir, filename);
    
    const debugData = {
      timestamp: new Date().toISOString(),
      batchName: batchName,
      requestCount: requests.length,
      requests: requests.map((request, index) => ({
        index: index,
        type: Object.keys(request)[0],
        request: request
      })),
      ...additionalData,
      metadata: {
        converterVersion: "1.0.0",
        nodeVersion: process.version,
        debugEnabled: this.isEnabled,
        debugDir: this.debugDir,
        filename: filename
      }
    };

    try {
      await fs.writeFile(filepath, JSON.stringify(debugData, null, 2));

    } catch (error) {
      console.error('Failed to save debug file:', error.message);
    }
  }

  async logSummary(summary) {
    if (!this.isEnabled) return;

    await this.ensureDebugDir();
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `sync-summary-${timestamp}.json`;
    const filepath = path.join(this.debugDir, filename);
    
    try {
      await fs.writeFile(filepath, JSON.stringify(summary, null, 2));

    } catch (error) {
      console.error('Failed to save debug file:', error.message);
    }
  }
}

/**
 * Google Docs Sync Engine
 * Main orchestrator for syncing Docusaurus content to Google Docs
 */
class GoogleDocsSync {
  constructor(googleDocsClient, projectRoot = process.cwd()) {
    this.client = googleDocsClient;
    this.projectRoot = projectRoot;
    this.converter = new GoogleDocsConverter();
    this.state = new GoogleDocsState(projectRoot);
    this.scanner = new DocusaurusScanner(projectRoot);
    
    // Initialize processors
    this.referenceProcessor = new ReferenceProcessor(projectRoot, this.state);
    
    // Google Drive integration for image upload
    this.driveClient = new GoogleDriveClient(projectRoot);
    this.gDocsImageProcessor = new GDocsImageProcessor(projectRoot);
    
    // Link and attachment processing
    this.linkProcessor = null; // Will be initialized after driveClient
    
    // Initialize debugger
    this.debugger = new GoogleDocsSyncDebugger(projectRoot);
  }

  /**
   * Initialize sync engine
   */
  async initialize() {
    console.log(chalk.blue('🚀 Initializing Google Docs sync engine...'));
    
    // Detect Docusaurus project
    await this.scanner.detectProject();
    
    // Initialize state manager
    await this.state.init();
    
    // Initialize Google Docs client
    await this.client.initialize();
    
    // Initialize Google Drive client with OAuth2 credentials
    try {
      await this.driveClient.initialize(this.client.oauth2Client, this.state);
      
      // Initialize Google Docs image processor
      await this.gDocsImageProcessor.initialize(this.driveClient, this.state);
      
      // Initialize link processor
      this.linkProcessor = new LinkProcessor(this.driveClient, this.projectRoot, this.state);
      await this.linkProcessor.initialize();
      
    } catch (error) {
      if (this.client.isPermissionError(error)) {
        console.log(chalk.yellow('⚠️ Permission error detected. Clearing old tokens and re-authenticating...'));
        await this.client.clearTokens();
        
        // Re-authenticate with new scopes
        await this.client.authenticate();
        await this.client.initialize();
        
        // Retry initialization
        await this.driveClient.initialize(this.client.oauth2Client, this.state);
        await this.gDocsImageProcessor.initialize(this.driveClient, this.state);
        
        // Re-initialize link processor
        this.linkProcessor = new LinkProcessor(this.driveClient, this.projectRoot, this.state);
        await this.linkProcessor.initialize();
      } else {
        throw error;
      }
    }
    
    console.log(chalk.green('✅ Google Docs sync engine initialized'));
  }

  /**
   * Sync all docs to Google Docs
   */
  async syncDocs(options = {}) {
    const { dryRun = false, force = false } = options;
    
    console.log(chalk.blue('📚 Starting Google Docs sync...'));
    
    if (dryRun) {
      console.log(chalk.yellow('🔍 DRY RUN MODE - No actual changes will be made'));
    }

    const spinner = ora('Scanning Docusaurus project...').start();
    
    try {
      // Reset stats for this sync
      this.state.resetStats();
      
      // Scan Docusaurus project
      spinner.text = 'Scanning Docusaurus project...';
      const documents = await this.scanner.scanDocs();
      
      if (documents.length === 0) {
        spinner.fail('No documents found to sync');
        return { success: false, message: 'No documents found' };
      }

      spinner.succeed(`Found ${documents.length} documents to scan`);
      
      // Get or create root document
      spinner.start('Setting up root Google Docs document...');
      const rootDocument = await this.ensureRootDocument();
      spinner.succeed(`Root document ready: ${rootDocument.title}`);
      
      // Filter documents that need sync
      spinner.start('Checking which documents need sync...');
      const filesToSync = force ? documents : await this.state.getFilesToSync(documents);
      
      if (filesToSync.length === 0) {
        spinner.succeed('All documents are up to date');
        return this.generateSyncReport();
      }

      spinner.succeed(`${filesToSync.length} documents need sync`);
      
      if (dryRun) {
        console.log(chalk.yellow('\n📋 DRY RUN - Would sync these files:'));
        filesToSync.forEach(file => {
          console.log(`   📄 ${file.relativePath} (${file.title})`);
        });
        return { success: true, dryRun: true, filesToSync };
      }

      // Process documents
      console.log(chalk.blue('\n📝 Processing documents...'));
      
      // CLEAR existing content before batch sync (similar to --file option)
      const currentDoc = await this.client.getDocument(rootDocument.documentId);
      const content = currentDoc.body?.content || [];
      let currentContentLength = 1;
      
      if (content.length > 0) {
        const lastElement = content[content.length - 1];
        currentContentLength = lastElement.endIndex || 1;
      }
      
              // Clear content if document has content to clear
        if (currentContentLength > 2) {
          await this.client.docs.documents.batchUpdate({
            documentId: rootDocument.documentId,
            requestBody: {
              requests: [{
                deleteContentRange: {
                  range: {
                    startIndex: 1,
                    endIndex: currentContentLength - 1
                  }
                }
              }]
            }
          });
          console.log(chalk.green('✅ Document content cleared successfully'));
        }
      
      // Process all documents and append to the same document
      for (let i = 0; i < filesToSync.length; i++) {
        const doc = filesToSync[i];
        const progress = `(${i + 1}/${filesToSync.length})`;
        
        try {
          spinner.start(`${progress} Processing ${doc.title}...`);
          await this.syncDocumentAppend(doc, rootDocument.documentId);
          spinner.succeed(`${progress} ✅ ${doc.title}`);
          this.state.updateStats('updated');
        } catch (error) {
          spinner.fail(`${progress} ❌ ${doc.title}: ${error.message}`);
          this.state.updateStats('failed');
        }
      }

      // Save state
      await this.state.save();
      
      return this.generateSyncReport();
      
    } catch (error) {
      spinner.fail('Sync failed');
      console.error(chalk.red('❌ Sync error:', error.message));
      throw error;
    }
  }

  /**
   * Sync single file to Google Docs
   */
  async syncFile(filePath, options = {}) {
    const { dryRun = false } = options;
    
    console.log(chalk.blue(`📄 Syncing file: ${filePath}`));
    
    if (dryRun) {
      console.log(chalk.yellow('🔍 DRY RUN MODE - No actual changes will be made'));
    }

    try {
      // Initialize if not already done
      if (!this.state.state || !this.state.state.lastSync) {
        await this.initialize();
      }

      // Parse file with scanner
      // Convert relative path to absolute path for scanner
      const absoluteFilePath = path.isAbsolute(filePath) ? filePath : path.join(this.projectRoot, filePath);
      const document = await this.scanner.parseFile(absoluteFilePath);
      
      if (!document) {
        throw new Error(`Failed to parse file: ${filePath}. File may not exist or is not a valid markdown file.`);
      }
      
      if (dryRun) {
        console.log(chalk.yellow('📋 DRY RUN - Would sync:'));
        console.log(chalk.gray(`   📄 ${document.title}`));
        console.log(chalk.gray(`   📁 ${document.relativePath}`));
        return { success: true, dryRun: true, document };
      }

      // Get or create root document
      const rootDocument = await this.ensureRootDocument();
      
      // Sync the document
      await this.syncDocument(document, rootDocument.documentId);
      
      // Save state
      await this.state.save();
      
      console.log(chalk.green(`✅ Successfully synced: ${document.title}`));
      
      return { 
        success: true, 
        document: document.title,
        url: rootDocument.url 
      };
      
    } catch (error) {
      console.error(chalk.red('❌ File sync error:', error.message));
      throw error;
    }
  }

  /**
   * Ensure root document exists
   */
  async ensureRootDocument() {
    const existingRoot = this.state.getRootDocument();
    
    if (existingRoot.documentId) {
      try {
        // Verify document still exists
        await this.client.getDocument(existingRoot.documentId);
        return existingRoot;
      } catch (error) {
        console.log(chalk.yellow('⚠️ Root document not found, creating new one...'));
      }
    }

    // Create new root document
    const rootDoc = await this.client.createDocument('Documentation');
    this.state.setRootDocument(rootDoc.documentId, rootDoc.url, 'Documentation');
    await this.state.save();
    
    return rootDoc;
  }

  /**
   * Sync single document (append mode for batch sync)
   */
  async syncDocumentAppend(document, rootDocumentId) {
    const { filePath, title, content: markdownContent } = document;
    
    try {
      // Process content with processors
      let processedContent = markdownContent;
      
      // Skip internal reference processing for Google Docs
      // Google Docs doesn't support complex linking like Confluence
      // Keep original markdown text instead of converting to links
      // Internal references will remain as plain text (e.g., "Create a page")

      // Process links and attachments FIRST to preserve backticks and special formatting
      let linkRequests = [];
      if (this.containsLinks(processedContent)) {
        console.log(chalk.blue('🔗 Processing links and attachments...'));
        const linkResult = await this.linkProcessor.processLinks(processedContent, filePath);
        processedContent = linkResult.processedMarkdown;
        linkRequests = linkResult.linkRequests;
        
        const linkStats = linkResult.stats;
        const originalExternalLinks = linkStats.externalLinks - linkStats.attachmentsUploaded - linkStats.attachmentsCached;
        const totalAttachments = linkStats.attachmentsUploaded + linkStats.attachmentsCached;
        console.log(chalk.green(`✅ Link processing complete: ${originalExternalLinks} external links, ${totalAttachments} attachments uploaded (${linkStats.attachmentsCached} cached)`));
        
        if (linkStats.errors.length > 0) {
          console.log(chalk.yellow(`⚠️ ${linkStats.errors.length} link processing errors`));
          linkStats.errors.forEach(error => {
            console.log(chalk.gray(`   - ${error}`));
          });
        }
      }

      // Process images and diagrams using Google Docs image processor
      let imageRequests = [];
      if (this.containsImages(processedContent) || this.containsDiagrams(processedContent)) {
        console.log(chalk.blue('🖼️ Processing images and diagrams...'));
        const imageResult = await this.gDocsImageProcessor.processImages(processedContent, filePath);
        processedContent = imageResult.processedMarkdown;
        imageRequests = imageResult.imageRequests;
        
        const imageStats = imageResult.stats;
        // console.log(chalk.green(`✅ Image processing complete: ${imageStats.imagesProcessed} images, ${imageStats.diagramsProcessed} diagrams`));
        
        if (imageStats.errors.length > 0) {
          console.log(chalk.yellow(`⚠️ ${imageStats.errors.length} image processing errors`));
          imageStats.errors.forEach(error => {
            console.log(chalk.gray(`   - ${error}`));
          });
        }
      }

      // Get document state for append positioning (document was cleared at batch start)
      const preAppendDoc = await this.client.getDocument(rootDocumentId);
      let contentStartIndex = 1;
      let existingTablesCount = 0;
      
      // Calculate where new content will start (append mode within cleared document)
      if (preAppendDoc.body && preAppendDoc.body.content && preAppendDoc.body.content.length > 0) {
        const lastElement = preAppendDoc.body.content[preAppendDoc.body.content.length - 1];
        contentStartIndex = lastElement.endIndex || 1;
        
        // Count existing tables (from previous documents in this batch)
        existingTablesCount = preAppendDoc.body.content.filter(element => element.table).length;
      }

      // Convert markdown to Google Docs requests
      const conversionResult = this.converter.convertFromMarkdown(processedContent, { 
        filePath: filePath,
        title: title
      });
      
      const { requests, tablesForStep2, formattingForStep2 } = conversionResult;

      // Step 1: Apply basic content and table structures (append mode)
      if (requests.length > 0) {
        await this.client.docs.documents.batchUpdate({
          documentId: rootDocumentId,
          requestBody: {
            requests: requests
          }
        });
      }

      // Step 1.5: Insert native images at their placeholder positions
      if (imageRequests.length > 0) {
        await this.insertImagesWithBatchProcessing(imageRequests, rootDocumentId);
      }

      // Step 2: Populate table cells if there are tables
      if (tablesForStep2 && tablesForStep2.length > 0) {
        // Get updated document to find actual table positions
        const updatedDoc = await this.client.getDocument(rootDocumentId);
        
        // Debug: Log document structure to file
        await this.debugger.logDocumentStructure(updatedDoc, 'step1-after-table-creation-append', {
          existingTablesCount: existingTablesCount,
          newTablesCount: tablesForStep2.length,
          contentStartIndex: contentStartIndex
        });
        
        // Create cell content requests using tableCellLocation
        const cellRequests = [];
        
        // Find ALL tables in document structure
        const allTables = this.findTablesInDocument(updatedDoc);
        
        // CRITICAL: Only process newly created tables (skip existing ones)
        const newTables = allTables.slice(existingTablesCount);
        
        // Debug table count information saved to file along with document structure
        
        // Process NEW tables in reverse order to avoid index shifts
        for (let i = tablesForStep2.length - 1; i >= 0 && i < newTables.length; i--) {
          const { tableData } = tablesForStep2[i];
          const tableElement = newTables[i];
          
          // Create cell content requests using actual table structure
          const tableCellRequests = this.createTableCellStructureRequests(tableData, tableElement);
          cellRequests.push(...tableCellRequests);
        }
        
        // Execute cell population requests
        if (cellRequests.length > 0) {
          // Debug: Log cell requests to file
          await this.debugger.logRequestBatch(cellRequests, 'cell-population-append', {
            tableCount: newTables.length,
            existingTablesCount: existingTablesCount
          });
          
          await this.client.docs.documents.batchUpdate({
            documentId: rootDocumentId,
            requestBody: {
              requests: cellRequests
            }
          });
        }
      }

      // Step 3: Apply text formatting and link formatting (COMBINED to reduce batchUpdate calls)
      const needsFormatting = formattingForStep2 && formattingForStep2.length > 0;
      const needsLinkFormatting = linkRequests && linkRequests.length > 0;
      
      if (needsFormatting || needsLinkFormatting) {
        // Get updated document structure to find actual text indices
        const finalDoc = await this.client.getDocument(rootDocumentId);
        
        const allFormattingRequests = [];
        
        // Add text formatting requests
        if (needsFormatting) {
          console.log(chalk.gray(`🎨 Preparing text formatting for ${formattingForStep2.length} elements...`));
          
          // CRITICAL: For append mode, reset ONLY new content to fix bold/size inheritance issues
          const resetColorRequests = this.createResetColorRequests(finalDoc, contentStartIndex);
          
          // Apply specific formatting with scope limited to new content
          const formattingRequests = this.createFormattingRequestsWithScope(
            formattingForStep2, 
            finalDoc, 
            contentStartIndex
          );
          
          allFormattingRequests.push(...resetColorRequests, ...formattingRequests);
        }
        
        // Add link text replacement requests (Phase 1)
        if (needsLinkFormatting) {
          const linkReplacementRequests = await this.createLinkFormattingRequests(linkRequests, finalDoc);
          allFormattingRequests.push(...linkReplacementRequests);
        }
        
        // Apply all formatting in single batch update
        if (allFormattingRequests.length > 0) {
          const textCount = needsFormatting ? formattingForStep2.length : 0;
          const linkCount = needsLinkFormatting ? linkRequests.length : 0;
          
          await this.client.docs.documents.batchUpdate({
            documentId: rootDocumentId,
            requestBody: {
              requests: allFormattingRequests
            }
          });
          
          console.log(chalk.green(`✅ Successfully applied text replacement and formatting`));
        }
        
        // Phase 2: Apply link formatting after text has been replaced
        if (needsLinkFormatting) {
          await this.applyLinkFormattingAfterReplacement(linkRequests, rootDocumentId);
        }
      }

      // Update state
      await this.state.updateDocument(filePath, {
        documentId: rootDocumentId,
        title,
        tabId: null, // Will be implemented in hierarchy phase
        parentTabId: null
      });

      return { success: true, title };
      
    } catch (error) {
      console.error(chalk.red(`❌ Error syncing document ${title}:`, error.message));
      throw error;
    }
  }

  /**
   * Sync single document (replace mode for single file sync)
   */
  async syncDocument(document, rootDocumentId) {
    const { filePath, title, content: markdownContent } = document;
    
    try {
      // Process content with processors
      let processedContent = markdownContent;
      
      // Skip internal reference processing for Google Docs
      // Google Docs doesn't support complex linking like Confluence
      // Keep original markdown text instead of converting to links
      // Internal references will remain as plain text (e.g., "Create a page")

      // Process links and attachments FIRST to preserve backticks and special formatting
      let linkRequests = [];
      if (this.containsLinks(processedContent)) {
        console.log(chalk.blue('🔗 Processing links and attachments...'));
        const linkResult = await this.linkProcessor.processLinks(processedContent, filePath);
        processedContent = linkResult.processedMarkdown;
        linkRequests = linkResult.linkRequests;
        
        const linkStats = linkResult.stats;
        const originalExternalLinks = linkStats.externalLinks - linkStats.attachmentsUploaded - linkStats.attachmentsCached;
        const totalAttachments = linkStats.attachmentsUploaded + linkStats.attachmentsCached;
        console.log(chalk.green(`✅ Link processing complete: ${originalExternalLinks} external links, ${totalAttachments} attachments uploaded (${linkStats.attachmentsCached} cached)`));
        
        if (linkStats.errors.length > 0) {
          console.log(chalk.yellow(`⚠️ ${linkStats.errors.length} link processing errors`));
          linkStats.errors.forEach(error => {
            console.log(chalk.gray(`   - ${error}`));
          });
        }
      }

      // Process images and diagrams using Google Docs image processor
      let imageRequests = [];
      if (this.containsImages(processedContent) || this.containsDiagrams(processedContent)) {
        console.log(chalk.blue('🖼️ Processing images and diagrams...'));
        const imageResult = await this.gDocsImageProcessor.processImages(processedContent, filePath);
        processedContent = imageResult.processedMarkdown;
        imageRequests = imageResult.imageRequests;
        
        const imageStats = imageResult.stats;
        // console.log(chalk.green(`✅ Image processing complete: ${imageStats.imagesProcessed} images, ${imageStats.diagramsProcessed} diagrams`));
        
        if (imageStats.errors.length > 0) {
          console.log(chalk.yellow(`⚠️ ${imageStats.errors.length} image processing errors`));
          imageStats.errors.forEach(error => {
            console.log(chalk.gray(`   - ${error}`));
          });
        }
      }

      // Always sync - clear and replace content each time
      
      // Get current document to check if it has content to clear
      const currentDoc = await this.client.getDocument(rootDocumentId);
      
      // Find the last content element to get the actual document length
      const content = currentDoc.body?.content || [];
      let currentContentLength = 1;
      
      if (content.length > 0) {
        // Get the endIndex of the last content element
        const lastElement = content[content.length - 1];
        currentContentLength = lastElement.endIndex || 1;
      }
      
      // console.log(chalk.gray(`📄 Current document length: ${currentContentLength} characters`));
      
      // Convert markdown to Google Docs requests
      const conversionResult = this.converter.convertFromMarkdown(processedContent, { 
        filePath: filePath,
        title: title
      });
      
      const { requests, tablesForStep2, formattingForStep2 } = conversionResult;

      // Step 1: Clear content and apply basic content and table structures
      const allRequests = [];
      
      // Add clear content request if document has content to clear
      if (currentContentLength > 2) { // Need at least 3 characters to have clearable content
        allRequests.push({
          deleteContentRange: {
            range: {
              startIndex: 1,
              endIndex: currentContentLength - 1
            }
          }
        });
      }
      
      // Add conversion requests
      allRequests.push(...requests);
      
      if (allRequests.length > 0) {
        await this.client.docs.documents.batchUpdate({
          documentId: rootDocumentId,
          requestBody: {
            requests: allRequests
          }
        });
      }

      // Step 1.5: Insert native images at their placeholder positions
      if (imageRequests.length > 0) {
        await this.insertImagesWithBatchProcessing(imageRequests, rootDocumentId);
      }

      // Step 2: Populate table cells if there are tables
      if (tablesForStep2 && tablesForStep2.length > 0) {
        // Get updated document to find actual table positions
        const updatedDoc = await this.client.getDocument(rootDocumentId);
        
        // Debug: Log document structure to file
        await this.debugger.logDocumentStructure(updatedDoc, 'step1-after-table-creation-replace', {
          newTablesCount: tablesForStep2.length
        });
        
        // Create cell content requests using tableCellLocation
        const cellRequests = [];
        
        // Find tables in document structure
        const tables = this.findTablesInDocument(updatedDoc);
        
        // Process tables in reverse order to avoid index shifts
        for (let i = tablesForStep2.length - 1; i >= 0 && i < tables.length; i--) {
          const { tableData } = tablesForStep2[i];
          const tableElement = tables[i];
          
          // Create cell content requests using actual table structure
          const tableCellRequests = this.createTableCellStructureRequests(tableData, tableElement);
          cellRequests.push(...tableCellRequests);
        }
        
        // Execute cell population requests
        if (cellRequests.length > 0) {
          // Debug: Log cell requests to file
          await this.debugger.logRequestBatch(cellRequests, 'cell-population-replace', {
            tableCount: tables.length
          });
          
          await this.client.docs.documents.batchUpdate({
            documentId: rootDocumentId,
            requestBody: {
              requests: cellRequests
            }
          });
        }
      }

      // Step 3: Apply text formatting and link formatting (COMBINED to reduce batchUpdate calls)
      const needsFormatting = formattingForStep2 && formattingForStep2.length > 0;
      const needsLinkFormatting = linkRequests && linkRequests.length > 0;
      
      if (needsFormatting || needsLinkFormatting) {
        // Get updated document structure to find actual text indices
        const finalDoc = await this.client.getDocument(rootDocumentId);
        
        const allFormattingRequests = [];
        
        // Add text formatting requests
        if (needsFormatting) {
          console.log(chalk.gray(`🎨 Preparing text formatting for ${formattingForStep2.length} elements...`));
          
          // First, reset document text color to black (fix gray text issue)
          const resetColorRequests = this.createResetColorRequests(finalDoc);
          
          // Then apply specific formatting
          const formattingRequests = this.createFormattingRequests(formattingForStep2, finalDoc);
          
          allFormattingRequests.push(...resetColorRequests, ...formattingRequests);
        }
        
        // Add link text replacement requests (Phase 1)
        if (needsLinkFormatting) {
          const linkReplacementRequests = await this.createLinkFormattingRequests(linkRequests, finalDoc);
          allFormattingRequests.push(...linkReplacementRequests);
        }
        
        // Apply all formatting in single batch update
        if (allFormattingRequests.length > 0) {
          const textCount = needsFormatting ? formattingForStep2.length : 0;
          const linkCount = needsLinkFormatting ? linkRequests.length : 0;
          
          await this.client.docs.documents.batchUpdate({
            documentId: rootDocumentId,
            requestBody: {
              requests: allFormattingRequests
            }
          });
          
          console.log(chalk.green(`✅ Successfully applied text replacement and formatting`));
        }
        
        // Phase 2: Apply link formatting after text has been replaced
        if (needsLinkFormatting) {
          await this.applyLinkFormattingAfterReplacement(linkRequests, rootDocumentId);
        }
      }

      // Update state
      await this.state.updateDocument(filePath, {
        documentId: rootDocumentId,
        title,
        tabId: null, // Will be implemented in hierarchy phase
        parentTabId: null
      });

      return { success: true, title };
      
    } catch (error) {
      console.error(chalk.red(`❌ Failed to sync document ${title}:`, error.message));
      throw error;
    }
  }

  /**
   * Check if content contains diagrams
   */
  containsDiagrams(content) {
    const diagramPatterns = [
      /```mermaid/,
      /```plantuml/,
      /```dot/,
      /```graphviz/,
      /```d2/
    ];
    
    return diagramPatterns.some(pattern => pattern.test(content));
  }

  /**
   * Check if content contains images or diagrams
   */
  containsImages(content) {
    // Regular images
    const hasImages = /!\[.*?\]\(.*?\)/.test(content) || /<img.*?src=/.test(content);
    
    // Mermaid diagrams
    const hasMermaid = /```mermaid\n/.test(content);
    
    // Other diagrams (existing detection from Confluence)
    const hasOtherDiagrams = this.containsDiagrams(content);
    
    return hasImages || hasMermaid || hasOtherDiagrams;
  }

  /**
   * Check if content contains links (external links or local attachments)
   */
  containsLinks(content) {
    const externalLinks = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
    const localFiles = /\[([^\]]+)\]\(\/[^)]+\.[^)]+\)/g;
    const relativeFiles = /\[([^\]]+)\]\(\.\/[^)]+\)/g;
    
    return externalLinks.test(content) || localFiles.test(content) || relativeFiles.test(content);
  }

  /**
   * Generate sync report
   */
  generateSyncReport() {
    const stats = this.state.getStats();
    const summary = this.state.getSummary();
    
    console.log(chalk.blue('\n📊 Sync Report'));
    console.log(chalk.gray('=================='));
    console.log(chalk.green(`✅ Created: ${stats.created}`));
    console.log(chalk.blue(`📝 Updated: ${stats.updated}`));
    console.log(chalk.gray(`⏭️ Skipped: ${stats.skipped}`));
    console.log(chalk.red(`❌ Failed: ${stats.failed}`));
    console.log(chalk.cyan(`📄 Total: ${stats.totalProcessed}`));
    
    if (summary.rootDocument.documentUrl) {
      console.log(chalk.cyan(`\n🔗 Google Docs: ${summary.rootDocument.documentUrl}`));
    }
    
    const syncResult = {
      success: stats.failed === 0,
      stats,
      summary,
      url: summary.rootDocument.documentUrl
    };
    
    // Debug: Log sync summary to file
    this.debugger.logSummary(syncResult).catch(error => {
      console.error('Failed to save sync summary debug file:', error.message);
    });
    
    return syncResult;
  }

  /**
   * Get sync status
   */
  async getStatus() {
    await this.state.init();
    const summary = this.state.getSummary();
    
    console.log(chalk.blue('📊 Google Docs Sync Status'));
    console.log(chalk.gray('============================'));
    console.log(chalk.cyan(`Root Document: ${summary.rootDocument.title || 'Not created'}`));
    console.log(chalk.cyan(`Total Documents: ${summary.totalDocuments}`));
    console.log(chalk.cyan(`Total Tabs: ${summary.totalTabs}`));
    console.log(chalk.cyan(`Last Sync: ${summary.lastSync || 'Never'}`));
    
    if (summary.rootDocument.documentUrl) {
      console.log(chalk.cyan(`URL: ${summary.rootDocument.documentUrl}`));
    }
    
    return summary;
  }

  /**
   * Clean up resources
   */
  async cleanup() {
    try {
      // Cleanup state
      await this.state.cleanup();
      await this.state.save();
      
      // Cleanup image processor
      if (this.gDocsImageProcessor) {
        await this.gDocsImageProcessor.cleanup();
      }
      
      // Cleanup drive client
      if (this.driveClient) {
        await this.driveClient.cleanup();
      }
      
      // Cleanup Google Docs client
      if (this.client) {
        await this.client.cleanup();
      }
      

      
    } catch (error) {
      console.warn(chalk.yellow('⚠️ Cleanup warning:', error.message));
    }
  }

  /**
   * Find all tables in document structure
   * @param {Object} document - Google Docs document object
   * @returns {Array} Array of table elements with startIndex
   */
  findTablesInDocument(document) {
    const tables = [];
    const content = document.body?.content || [];
    
    content.forEach(element => {
      if (element.table) {
        tables.push({
          startIndex: element.startIndex,
          endIndex: element.endIndex,
          table: element.table
        });
      }
    });
    
    return tables;
  }

  /**
   * Create table cell content requests using actual table structure
   * Uses the real paragraph indices from Google Docs table structure
   * @param {Object} tableData - Table data with headers and rows
   * @param {Object} tableElement - Table element from document structure
   * @returns {Array} Array of insertText requests with actual paragraph indices
   */
  createTableCellStructureRequests(tableData, tableElement) {
    const requests = [];
    const { headers, rows } = tableData;
    
    // Combine headers and rows into all rows
    const allRows = [headers, ...rows];
    
    // Extract paragraph indices from actual table structure
    if (tableElement.table && tableElement.table.tableRows) {
      allRows.forEach((row, rowIndex) => {
        if (tableElement.table.tableRows[rowIndex] && tableElement.table.tableRows[rowIndex].tableCells) {
          row.forEach((cellText, columnIndex) => {
            const tableCell = tableElement.table.tableRows[rowIndex].tableCells[columnIndex];
            if (tableCell && tableCell.content && tableCell.content.length > 0) {
              // Find the first paragraph in this cell
              const paragraph = tableCell.content.find(content => content.paragraph);
              if (paragraph && cellText && cellText.trim()) {
                // Insert text at the start of the paragraph (startIndex)
                requests.push({
                  insertText: {
                    text: cellText,
                    location: {
                      index: paragraph.startIndex
                    }
                  }
                });
              }
            }
          });
        }
      });
    }
    
    // Debug: Table cell indices logged to file with request batch
    
    // CRITICAL: Reverse order within table to avoid index shifts (GitHub Gist approach)
    return requests.reverse();
  }



  /**
   * Create formatting requests using actual document structure
   * @param {Array} formattingForStep2 - Formatting data from converter
   * @param {Object} document - Current document structure
   * @returns {Array} Array of formatting requests
   */
  createFormattingRequests(formattingForStep2, document) {
    const requests = [];
    
    // Extract text content from document to find actual text positions
    const textElements = this.extractTextElements(document);
    
    for (const formatItem of formattingForStep2) {
      const { type, text, textLength, level, language, content, formats } = formatItem;
      
      if (type === 'heading') {
        // Find heading text in document and apply formatting
        const textPosition = this.findTextInDocument(text, textElements);
        if (textPosition) {
          requests.push({
            updateTextStyle: {
              range: {
                startIndex: textPosition.startIndex,
                endIndex: textPosition.startIndex + textLength
              },
              textStyle: {
                bold: true,
                fontSize: {
                  magnitude: this.getHeadingSize(level),
                  unit: 'PT'
                },
                foregroundColor: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } } // Ensure black text
              },
              fields: 'bold,fontSize,foregroundColor'
            }
          });
        }
      } else if (type === 'code_block') {
        // Find code block text and apply formatting
        if (language) {
          // Format language label
          const labelText = `[${language}]`;
          const labelPosition = this.findTextInDocument(labelText, textElements);
          if (labelPosition) {
            requests.push({
              updateTextStyle: {
                range: {
                  startIndex: labelPosition.startIndex,
                  endIndex: labelPosition.startIndex + labelText.length
                },
                textStyle: {
                  bold: true,
                  fontSize: { magnitude: 9, unit: 'PT' },
                  foregroundColor: { color: { rgbColor: { red: 0.5, green: 0.5, blue: 0.5 } } },
                  backgroundColor: { color: { rgbColor: { red: 1, green: 1, blue: 1 } } } // White background
                },
                fields: 'bold,fontSize,foregroundColor,backgroundColor'
              }
            });
          }
        }
        
        // Format code content
        const codePosition = this.findTextInDocument(content, textElements);
        if (codePosition) {
          requests.push({
            updateTextStyle: {
              range: {
                startIndex: codePosition.startIndex,
                endIndex: codePosition.startIndex + content.length
              },
              textStyle: {
                backgroundColor: { color: { rgbColor: { red: 0.95, green: 0.95, blue: 0.95 } } },
                foregroundColor: { color: { rgbColor: { red: 0.2, green: 0.2, blue: 0.2 } } }, // Dark gray for code blocks
                fontSize: { magnitude: 10, unit: 'PT' },
                bold: false,
                italic: false
              },
              fields: 'backgroundColor,foregroundColor,fontSize,bold,italic'
            }
          });
        }
      } else if (type === 'paragraph' && formats && formats.length > 0) {
        // Find paragraph text and apply inline formatting
        const paragraphPosition = this.findTextInDocument(formatItem.processedText, textElements);
        if (paragraphPosition) {
          // Don't reset paragraph formatting - just apply specific inline formatting
          for (const format of formats) {
            requests.push({
              updateTextStyle: {
                range: {
                  startIndex: paragraphPosition.startIndex + format.start,
                  endIndex: paragraphPosition.startIndex + format.end
                },
                textStyle: format.style,
                fields: this.generateFieldsString(format.style)
              }
            });
          }
        }
      }
    }
    
    return requests;
  }

  /**
   * Create formatting requests with scope limited to new content only (for append mode)
   * @param {Array} formattingForStep2 - Formatting data from converter
   * @param {Object} document - Current document structure
   * @param {number} contentStartIndex - Start index of newly added content
   * @returns {Array} Array of formatting requests limited to new content
   */
  createFormattingRequestsWithScope(formattingForStep2, document, contentStartIndex) {
    const requests = [];
    
    // Extract text content from document to find actual text positions
    const allTextElements = this.extractTextElements(document);
    
    // CRITICAL: Filter text elements to only include new content
    const newTextElements = allTextElements.filter(element => 
      element.startIndex >= contentStartIndex
    );
    
    // Debug: Formatting scope information logged to file with request batch
    
    for (const formatItem of formattingForStep2) {
      const { type, text, textLength, level, language, content, formats } = formatItem;
      
      if (type === 'heading') {
        // Find heading text in NEW content only
        const textPosition = this.findTextInDocument(text, newTextElements);
        if (textPosition) {
          requests.push({
            updateTextStyle: {
              range: {
                startIndex: textPosition.startIndex,
                endIndex: textPosition.startIndex + textLength
              },
              textStyle: {
                bold: true,
                fontSize: {
                  magnitude: this.getHeadingSize(level),
                  unit: 'PT'
                },
                foregroundColor: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } } // Ensure black text
              },
              fields: 'bold,fontSize,foregroundColor'
            }
          });
        }
      } else if (type === 'code_block') {
        // Find code block text in NEW content only
        if (language) {
          // Format language label
          const labelText = `[${language}]`;
          const labelPosition = this.findTextInDocument(labelText, newTextElements);
          if (labelPosition) {
            requests.push({
              updateTextStyle: {
                range: {
                  startIndex: labelPosition.startIndex,
                  endIndex: labelPosition.startIndex + labelText.length
                },
                textStyle: {
                  bold: true,
                  fontSize: { magnitude: 9, unit: 'PT' },
                  foregroundColor: { color: { rgbColor: { red: 0.5, green: 0.5, blue: 0.5 } } },
                  backgroundColor: { color: { rgbColor: { red: 1, green: 1, blue: 1 } } } // White background
                },
                fields: 'bold,fontSize,foregroundColor,backgroundColor'
              }
            });
          }
        }
        
        // Format code content
        const codePosition = this.findTextInDocument(content, newTextElements);
        if (codePosition) {
          requests.push({
            updateTextStyle: {
              range: {
                startIndex: codePosition.startIndex,
                endIndex: codePosition.startIndex + content.length
              },
              textStyle: {
                backgroundColor: { color: { rgbColor: { red: 0.95, green: 0.95, blue: 0.95 } } },
                foregroundColor: { color: { rgbColor: { red: 0.2, green: 0.2, blue: 0.2 } } }, // Dark gray for code blocks
                fontSize: { magnitude: 10, unit: 'PT' },
                bold: false,
                italic: false
              },
              fields: 'backgroundColor,foregroundColor,fontSize,bold,italic'
            }
          });
        }
      } else if (type === 'paragraph' && formats && formats.length > 0) {
        // Find paragraph text in NEW content only
        const paragraphPosition = this.findTextInDocument(formatItem.processedText, newTextElements);
        if (paragraphPosition) {
          // Don't reset paragraph formatting - just apply specific inline formatting
          for (const format of formats) {
            requests.push({
              updateTextStyle: {
                range: {
                  startIndex: paragraphPosition.startIndex + format.start,
                  endIndex: paragraphPosition.startIndex + format.end
                },
                textStyle: format.style,
                fields: this.generateFieldsString(format.style)
              }
            });
          }
        }
      }
    }
    
    // Debug: Formatting request count logged to file with request batch
    
    return requests;
  }

  /**
   * Extract all text elements from document
   */
  extractTextElements(document) {
    const textElements = [];
    
    if (document.body && document.body.content) {
      for (const element of document.body.content) {
        if (element.paragraph && element.paragraph.elements) {
          for (const paragraphElement of element.paragraph.elements) {
            if (paragraphElement.textRun && paragraphElement.textRun.content) {
              textElements.push({
                text: paragraphElement.textRun.content,
                startIndex: paragraphElement.startIndex,
                endIndex: paragraphElement.endIndex
              });
            }
          }
        }
      }
    }
    
    return textElements;
  }

  /**
   * Find text position in document
   */
  findTextInDocument(searchText, textElements) {
    // Combine all text to search
    let fullText = '';
    const indexMap = [];
    
    for (const element of textElements) {
      const startPos = fullText.length;
      fullText += element.text;
      const endPos = fullText.length;
      
      indexMap.push({
        textStart: startPos,
        textEnd: endPos,
        docStart: element.startIndex,
        docEnd: element.endIndex
      });
    }
    
    // Try to find the original placeholder first
    let textIndex = fullText.indexOf(searchText);
    let actualSearchText = searchText;
    
    // Simple format should not be processed by GoogleDocsConverter
    // [[[LINK_0]]] should remain as-is
    
    if (textIndex === -1) return null;
    
    // Map back to document indices
    for (const mapping of indexMap) {
      if (textIndex >= mapping.textStart && textIndex < mapping.textEnd) {
        const offset = textIndex - mapping.textStart;
        return {
          startIndex: mapping.docStart + offset,
          endIndex: mapping.docStart + offset + actualSearchText.length
        };
      }
    }
    
    return null;
  }

  /**
   * Create requests to reset text color to black for newly added content only
   * @param {Object} document - Current document structure
   * @param {number} contentStartIndex - Start index of newly added content (optional)
   * @returns {Array} Reset color requests for new content only
   */
  createResetColorRequests(document, contentStartIndex = null) {
    const requests = [];
    
    // Get document content length
    let documentLength = 1;
    if (document.body && document.body.content && document.body.content.length > 0) {
      const lastElement = document.body.content[document.body.content.length - 1];
      documentLength = lastElement.endIndex || 1;
    }
    
    // For append mode, only reset newly added content
    // For replace mode (single file), reset entire document
    let resetStartIndex = contentStartIndex || 1;
    
    // COMPREHENSIVE RESET: Reset ALL formatting to default to fix bold/size issues
    if (documentLength > resetStartIndex + 1) {
      requests.push({
        updateTextStyle: {
          range: {
            startIndex: resetStartIndex,
            endIndex: documentLength - 1
          },
          textStyle: {
            foregroundColor: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } }, // Black text
            bold: false, // Reset bold to fix normal text bold issue
            italic: false, // Reset italic
            fontSize: { magnitude: 11, unit: 'PT' }, // Reset font size to fix size 20 issue
            backgroundColor: {} // Clear background color
          },
          fields: 'foregroundColor,bold,italic,fontSize,backgroundColor'
        }
      });
    }
    
    return requests;
  }

  /**
   * Generate fields string for Google Docs API
   */
  generateFieldsString(style) {
    const fields = [];
    
    if (style.bold !== undefined) fields.push('bold');
    if (style.italic !== undefined) fields.push('italic');
    if (style.fontSize !== undefined) fields.push('fontSize');
    if (style.foregroundColor !== undefined) fields.push('foregroundColor');
    if (style.backgroundColor !== undefined) fields.push('backgroundColor');
    if (style.underline !== undefined) fields.push('underline');
    if (style.strikethrough !== undefined) fields.push('strikethrough');
    
    return fields.join(',');
  }

  /**
   * Get heading font size based on level
   */
  getHeadingSize(level) {
    const sizes = {
      1: 20,
      2: 18,
      3: 16,
      4: 14,
      5: 12,
      6: 11
    };
    return sizes[level] || 11;
  }

  /**
   * Extract text from paragraph element
   */
  extractTextFromParagraph(paragraph) {
    let text = '';
    if (paragraph.elements) {
      for (const element of paragraph.elements) {
        if (element.textRun) {
          text += element.textRun.content || '';
        }
      }
    }
    return text;
  }

  /**
   * Create native image insertion requests by finding and replacing placeholders
   * @param {Array} imageRequests - Array of image requests with placeholders
   * @param {Object} document - Google Docs document object
   * @returns {Array} - Array of Google Docs API requests for image insertion
   */
  async processImageInsertionBatches(imageRequests, documentId) {
    if (!imageRequests || imageRequests.length === 0) {
      return { success: true, insertedCount: 0 };
    }

    try {
      // Process images in batches to avoid API limits
      const BATCH_SIZE = 5; // Smaller batch size to avoid API errors
      let totalInserted = 0;
      
      // Calculate number of batches needed
      const totalBatches = Math.ceil(imageRequests.length / BATCH_SIZE);

      
      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        const startIndex = batchIndex * BATCH_SIZE;
        const endIndex = Math.min(startIndex + BATCH_SIZE, imageRequests.length);
        const batchImageRequests = imageRequests.slice(startIndex, endIndex);
        
        // Get current document state for this batch
        const currentDoc = await this.client.getDocument(documentId);
        
        // Create insertion requests for this batch
        const batchRequests = await this.createImageInsertionRequests(batchImageRequests, currentDoc);
        
        if (batchRequests.length > 0) {
          try {
            await this.client.docs.documents.batchUpdate({
              documentId: documentId,
              requestBody: {
                requests: batchRequests
              }
            });
            
            const imagesInBatch = batchRequests.length / 2; // Each image has 2 requests (delete + insert)
            totalInserted += imagesInBatch;
            
          } catch (batchError) {
            throw batchError;
          }
        }
      }
      
      return { success: true, insertedCount: totalInserted };
      
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Insert images with batch processing and automatic fallback
   */
  async insertImagesWithBatchProcessing(imageRequests, documentId) {
    if (!imageRequests || imageRequests.length === 0) {
      return { success: true, insertedCount: 0 };
    }


    
    // Try batch processing first
    const batchResult = await this.processImageInsertionBatches(imageRequests, documentId);
    
    if (batchResult.success) {
      return batchResult;
    }
    
    // If batch processing fails, use fallback
    await this.insertImagesAsFallback(imageRequests, documentId);
    
    return { success: true, insertedCount: imageRequests.length, fallback: true };
  }

  /**
   * Fallback method to insert images as markdown when native insertion fails
   */
  async insertImagesAsFallback(imageRequests, documentId) {
    try {
      // Get current document state
      const currentDoc = await this.client.getDocument(documentId);
      const textElements = this.extractTextElements(currentDoc);
      
      // Find all placeholder positions first
      const placeholderPositions = [];
      
      for (const imageRequest of imageRequests) {
        const placeholder = imageRequest.placeholder;
        const placeholderPosition = this.findTextInDocument(placeholder, textElements);
        
        if (placeholderPosition) {
          placeholderPositions.push({
            imageRequest,
            placeholder,
            position: placeholderPosition
          });
        }
      }
      
      // Sort by position (highest index first) to avoid index shifts
      placeholderPositions.sort((a, b) => b.position.startIndex - a.position.startIndex);
      
      // Process placeholders in reverse order
      const fallbackRequests = [];
      for (const item of placeholderPositions) {
        const { imageRequest, placeholder, position } = item;
        const markdownImage = `![${imageRequest.altText}](${imageRequest.url})`;
        
        // Delete placeholder first
        fallbackRequests.push({
          deleteContentRange: {
            range: {
              startIndex: position.startIndex,
              endIndex: position.endIndex
            }
          }
        });
        
        // Insert markdown image at the same position
        fallbackRequests.push({
          insertText: {
            text: markdownImage,
            location: {
              index: position.startIndex
            }
          }
        });
      }
      
      // Execute all requests in one batch
      if (fallbackRequests.length > 0) {
        await this.client.docs.documents.batchUpdate({
          documentId: documentId,
          requestBody: {
            requests: fallbackRequests
          }
        });
      }
      
    } catch (error) {
      throw error;
    }
  }

  /**
   * Create image insertion requests from image data
   */
  async createImageInsertionRequests(imageRequests, document) {
    const requests = [];
    
    try {
      if (!imageRequests || imageRequests.length === 0) {
        return requests;
      }
      
      // Extract all text content from document
      const textElements = this.extractTextElements(document);
      const fullText = textElements.map(el => el.text).join('');
      

      
      // Find all placeholder positions first, then process in reverse order
      const placeholderPositions = [];
      
      for (let i = 0; i < imageRequests.length; i++) {
        const imageRequest = imageRequests[i];
        const placeholder = imageRequest.placeholder;
        

        
        // Find placeholder position in document
        const placeholderPosition = this.findTextInDocument(placeholder, textElements);
        
        if (placeholderPosition) {
          placeholderPositions.push({
            imageRequest,
            placeholder,
            position: placeholderPosition,
            originalIndex: i
          });
          
        }
      }
      
      // Sort by position (highest index first) to avoid index shifts
      placeholderPositions.sort((a, b) => b.position.startIndex - a.position.startIndex);
      
      // Process placeholders from highest index to lowest to avoid index shifts
      for (const item of placeholderPositions) {
        const { imageRequest, placeholder, position } = item;
        
        // Convert Google Drive URL to direct access format for API
        let imageUrl = imageRequest.url;
        
        if (imageUrl.includes('drive.google.com/uc?export=view&id=')) {
          // Convert to direct download format that Google Docs API can access
          const fileId = imageUrl.match(/id=([^&]+)/)?.[1];
          if (fileId) {
            imageUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
          }
        }
        
        // Delete placeholder text first
        requests.push({
          deleteContentRange: {
            range: {
              startIndex: position.startIndex,
              endIndex: position.endIndex
            }
          }
        });
        
        // Insert native image at the same position
        requests.push({
          insertInlineImage: {
            uri: imageUrl,
            location: {
              index: position.startIndex
            }
          }
        });
      }
      
      return requests;
      
    } catch (error) {
      return [];
    }
  }

  /**
   * Create link text replacement requests for Google Docs (Phase 1)
   * Process placeholders and replace with text only - formatting applied separately
   * @param {Array} linkRequests - Array of link request objects
   * @param {Object} document - Google Docs document object
   * @returns {Array} Array of Google Docs API requests for text replacement only
   */
  async createLinkFormattingRequests(linkRequests, document) {
    const requests = [];
    
    if (process.env.DEBUG_GDOCS_CONVERTER === 'true') {
      console.log(chalk.gray(`🐛 Phase 1: Creating text replacement for ${linkRequests.length} links`));
    }
    
    // Use replaceAllText for each placeholder to avoid index conflicts
    for (let i = 0; i < linkRequests.length; i++) {
      const linkRequest = linkRequests[i];
      const placeholder = linkRequest.placeholder;
      
      if (process.env.DEBUG_GDOCS_CONVERTER === 'true') {
        console.log(chalk.gray(`🐛 Replacing placeholder "${placeholder}" with text "${linkRequest.text}"`));
      }
      
      // Use replaceAllText to avoid index conflicts in batch processing
      requests.push({
        replaceAllText: {
          containsText: {
            text: placeholder,
            matchCase: true
          },
          replaceText: linkRequest.text
        }
      });
    }
    
    if (process.env.DEBUG_GDOCS_CONVERTER === 'true') {
      console.log(chalk.gray(`🐛 Phase 1: Created ${requests.length} text replacement requests`));
    }
    
    return requests;
  }

  /**
   * Apply link formatting after text replacement (Phase 2)
   * @param {Array} linkRequests - Array of link request objects
   * @param {string} documentId - Google Docs document ID
   */
  async applyLinkFormattingAfterReplacement(linkRequests, documentId) {
    try {
      // Get fresh document state after text replacement
      const currentDoc = await this.client.getDocument(documentId);
      const textElements = this.extractTextElements(currentDoc);
      
      const formattingRequests = [];
      const usedPositions = new Set(); // Track used positions to avoid duplicates
      
      // Group link requests by text to handle multiple references efficiently
      const textToRequests = new Map();
      for (const linkRequest of linkRequests) {
        const text = linkRequest.text;
        if (!textToRequests.has(text)) {
          textToRequests.set(text, []);
        }
        textToRequests.get(text).push(linkRequest);
      }
      
      if (process.env.DEBUG_GDOCS_CONVERTER === 'true') {
        console.log(chalk.gray(`🐛 Phase 2: Processing ${textToRequests.size} unique texts for ${linkRequests.length} total links`));
      }
      
      for (const [textToFind, requests] of textToRequests) {
        // Find all occurrences of this text
        const textPositions = this.findAllTextOccurrences(textToFind, textElements);
        
        if (process.env.DEBUG_GDOCS_CONVERTER === 'true') {
          console.log(chalk.gray(`🐛 Found ${textPositions.length} occurrences of "${textToFind}" for ${requests.length} requests`));
        }
        
        if (textPositions.length > 0) {
          // Format each occurrence with the corresponding URL
          // Match requests to positions based on order (first request gets first position, etc.)
          for (let i = 0; i < Math.min(requests.length, textPositions.length); i++) {
            const position = textPositions[i];
            const linkRequest = requests[i];
            
            // Create a unique position key to avoid duplicates
            const positionKey = `${position.startIndex}-${position.endIndex}`;
            
            if (!usedPositions.has(positionKey)) {
              usedPositions.add(positionKey);
              
              formattingRequests.push({
                updateTextStyle: {
                  textStyle: {
                    link: {
                      url: linkRequest.url
                    },
                    foregroundColor: {
                      color: {
                        rgbColor: {
                          blue: 1.0,
                          green: 0.0,
                          red: 0.0
                        }
                      }
                    },
                    underline: true
                  },
                  range: {
                    startIndex: position.startIndex,
                    endIndex: position.endIndex
                  },
                  fields: "link,foregroundColor,underline"
                }
              });
              
              if (process.env.DEBUG_GDOCS_CONVERTER === 'true') {
                console.log(chalk.gray(`🔗 Link formatting: "${textToFind}" → ${linkRequest.url} (${position.startIndex}-${position.endIndex})`));
              }
            } else {
              if (process.env.DEBUG_GDOCS_CONVERTER === 'true') {
                console.log(chalk.gray(`🔗 Skipping duplicate position: "${textToFind}" (${position.startIndex}-${position.endIndex})`));
              }
            }
          }
          
          // If there are more requests than positions, warn about unmatched requests
          if (requests.length > textPositions.length) {
            const unmatchedCount = requests.length - textPositions.length;
            console.warn(chalk.yellow(`⚠️ ${unmatchedCount} link requests for "${textToFind}" could not be matched to text positions`));
          }
        } else {
          console.warn(chalk.yellow(`⚠️ Could not find text for link formatting: "${textToFind}"`));
          
          if (process.env.DEBUG_GDOCS_CONVERTER === 'true') {
            const fullText = textElements.map(el => el.text).join('');
            console.log(chalk.gray(`🐛 Available text in document (first 200 chars): "${fullText.substring(0, 200)}..."`));
            
            // Try to find similar text
            const words = textToFind.split(' ');
            for (const word of words) {
              if (word.length > 3 && fullText.includes(word)) {
                console.log(chalk.gray(`🐛 Found partial match for word: "${word}"`));
              }
            }
          }
        }
      }
      
      // Apply all link formatting in one batch
      if (formattingRequests.length > 0) {
        await this.client.docs.documents.batchUpdate({
          documentId: documentId,
          requestBody: {
            requests: formattingRequests
          }
        });
        
        console.log(chalk.green(`✅ Successfully applied link formatting for ${formattingRequests.length} links`));
      } else {
        console.warn(chalk.yellow(`⚠️ No link formatting requests were created`));
      }
      
    } catch (error) {
      console.warn(chalk.yellow(`⚠️ Error applying link formatting: ${error.message}`));
      
      if (process.env.DEBUG_GDOCS_CONVERTER === 'true') {
        console.error(chalk.red(`🐛 Phase 2 error details:`), error);
      }
    }
  }

  /**
   * Find all occurrences of text in document
   * @param {string} searchText - Text to find
   * @param {Array} textElements - Document text elements
   * @returns {Array} Array of positions {startIndex, endIndex}
   */
  findAllTextOccurrences(searchText, textElements) {
    const positions = [];
    let fullText = '';
    const indexMap = [];
    
    for (const element of textElements) {
      const startPos = fullText.length;
      fullText += element.text;
      const endPos = fullText.length;
      
      indexMap.push({
        textStart: startPos,
        textEnd: endPos,
        docStart: element.startIndex,
        docEnd: element.endIndex
      });
    }
    
    // Find all occurrences
    let searchIndex = 0;
    while ((searchIndex = fullText.indexOf(searchText, searchIndex)) !== -1) {
      // Map back to document indices
      for (const mapping of indexMap) {
        if (searchIndex >= mapping.textStart && searchIndex < mapping.textEnd) {
          const offset = searchIndex - mapping.textStart;
          positions.push({
            startIndex: mapping.docStart + offset,
            endIndex: mapping.docStart + offset + searchText.length
          });
          break;
        }
      }
      searchIndex += searchText.length;
    }
    
    return positions;
  }
  

}

module.exports = GoogleDocsSync;