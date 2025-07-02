const { google } = require('googleapis');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const chalk = require('chalk');
const axios = require('axios');

/**
 * Google Drive Client for Image Upload
 * Handles image uploads to Google Drive and returns public URLs for Google Docs
 */
class GoogleDriveClient {
  constructor(projectRoot = process.cwd()) {
    this.projectRoot = projectRoot;
    this.oauth2Client = null;
    this.drive = null;
    this.imageFolder = null;
    this.imageFolderId = null;
    
    // State management
    this.stateManager = null;
    this.uploadedImages = new Map(); // Cache for current session
    
    // Debug configuration
    this.debug = process.env.DEBUG_GDOCS_CONVERTER === 'true';
  }

  /**
   * Initialize Google Drive client with existing OAuth2 credentials
   * @param {OAuth2Client} oauth2Client - Authenticated OAuth2 client from GoogleDocsClient
   * @param {StateManager} stateManager - State manager for persistence
   */
  async initialize(oauth2Client, stateManager) {
    try {
      this.oauth2Client = oauth2Client;
      this.stateManager = stateManager;
      
      // Initialize Google Drive API
      this.drive = google.drive({ version: 'v3', auth: this.oauth2Client });
      
      // Ensure image folder exists
      await this.ensureImageFolder();
      
      console.log(chalk.green('✅ Google Drive client initialized successfully'));
      return true;
    } catch (error) {
      console.error(chalk.red('❌ Failed to initialize Google Drive client:'), error.message);
      throw error;
    }
  }

  /**
   * Ensure image folder exists in Google Drive
   */
  async ensureImageFolder() {
    try {
      // Check if folder ID exists in state
      const state = await this.stateManager.loadState();
      this.imageFolderId = state.googleDrive?.imageFolderId;

      if (this.imageFolderId) {
        // Verify folder still exists
        try {
          const folder = await this.drive.files.get({
            fileId: this.imageFolderId,
            fields: 'id,name,trashed'
          });
          
          if (!folder.data.trashed) {
            return this.imageFolderId;
          } else {
            console.log(chalk.yellow('⚠️ Existing folder is trashed, creating new one...'));
            this.imageFolderId = null;
          }
        } catch (error) {
          console.log(chalk.yellow('⚠️ Existing folder not found, creating new one...'));
          this.imageFolderId = null;
        }
      }

      // Create new folder only if none exists
      const folderName = `docflu-files-${Date.now()}`;
      const folderMetadata = {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['root']
      };

      console.log(chalk.blue(`📁 Creating files folder: ${folderName}`));
      const folder = await this.drive.files.create({
        resource: folderMetadata,
        fields: 'id,name'
      });

      this.imageFolderId = folder.data.id;
      
      // Make folder publicly viewable
      await this.drive.permissions.create({
        fileId: this.imageFolderId,
        resource: {
          role: 'reader',
          type: 'anyone'
        }
      });

      // Save folder ID to state immediately to prevent duplicate folders
      const currentState = await this.stateManager.loadState();
      await this.stateManager.updateState({
        googleDrive: {
          ...currentState.googleDrive,
          imageFolderId: this.imageFolderId,
          imageFolderName: folderName,
          createdAt: new Date().toISOString(),
          uploadedImages: currentState.googleDrive?.uploadedImages || {}
        }
      });

      console.log(chalk.green(`✅ Image folder created and saved: ${folderName} (${this.imageFolderId})`));
      return this.imageFolderId;
      
    } catch (error) {
      console.error(chalk.red('❌ Failed to ensure image folder:'), error.message);
      throw error;
    }
  }

  /**
   * Convert SVG to PNG if needed for Google Docs compatibility
   * @param {string} imagePath - Path to image file
   * @returns {string} - Path to converted image or original if no conversion needed
   */
  async convertImageForGoogleDocs(imagePath, contentType = null) {
    const ext = path.extname(imagePath).toLowerCase();
    
    // Check if conversion is needed (check both extension and content type)
    const isSvg = ext === '.svg' || contentType === 'image/svg+xml';
    
    if (!isSvg) {
      return imagePath; // No conversion needed
    }

    try {
      // Try to load sharp for SVG conversion
      let sharp;
      try {
        sharp = require('sharp');
      } catch (error) {
        console.warn(chalk.yellow('⚠️ Sharp package not available, uploading SVG as-is (may not display properly in Google Docs)'));
        return imagePath;
      }

      const tempDir = path.join(this.projectRoot, '.docusaurus', 'temp');
      await fs.ensureDir(tempDir);
      
      const baseName = path.basename(imagePath, ext);
      const pngPath = path.join(tempDir, `${baseName}.png`);
      
      // console.log(chalk.blue(`🔄 Converting SVG to PNG: ${path.basename(imagePath)}`));
      
      // Convert SVG to PNG using Sharp
      await sharp(imagePath)
        .png({
          quality: 90,
          compressionLevel: 6
        })
        .resize(1200, 1200, {
          fit: 'inside',
          withoutEnlargement: true,
          background: { r: 255, g: 255, b: 255, alpha: 1 }
        })
        .toFile(pngPath);
      
      if (await fs.pathExists(pngPath)) {
        // console.log(chalk.green(`✅ SVG converted to PNG: ${path.basename(pngPath)}`));
        return pngPath;
      } else {
        throw new Error('PNG conversion failed');
      }
      
    } catch (error) {
      console.warn(chalk.yellow(`⚠️ SVG conversion failed: ${error.message}, uploading original`));
      return imagePath;
    }
  }

  /**
   * Upload image to Google Drive and return public URL
   * @param {string} imagePath - Local path to image file
   * @param {string} imageHash - Hash of image content for caching
   * @returns {Object} - { url, fileId, cached }
   */
  async uploadImage(imagePath, imageHash = null) {
    try {
      // Convert SVG to PNG if needed for Google Docs compatibility
      const processedImagePath = await this.convertImageForGoogleDocs(imagePath);
      
      // Generate hash if not provided (use processed image for hash)
      if (!imageHash) {
        const imageBuffer = await fs.readFile(processedImagePath);
        imageHash = crypto.createHash('sha256').update(imageBuffer).digest('hex');
      }

      // Check if image already uploaded (session cache)
      if (this.uploadedImages.has(imageHash)) {
        const cachedResult = this.uploadedImages.get(imageHash);
        return { ...cachedResult, cached: true };
      }

      // Check if image exists in persistent state
      const state = await this.stateManager.loadState();
      const uploadedImage = state.googleDrive?.uploadedImages?.[imageHash];
      
      if (uploadedImage) {
        // Verify image still exists in Drive and is accessible
        try {
          const file = await this.drive.files.get({
            fileId: uploadedImage.fileId,
            fields: 'id,name,trashed,webViewLink'
          });
          
          if (!file.data.trashed) {

            // Update session cache
            this.uploadedImages.set(imageHash, uploadedImage);
            return { ...uploadedImage, cached: true };
          }
        } catch (error) {
          // Re-upload if cached image not accessible
        }
      }

      // Upload new image (use processed image path)
      const fileName = `${imageHash.substring(0, 8)}-${path.basename(processedImagePath)}`;
      const mimeType = this.getMimeType(processedImagePath);
      

      
      const fileMetadata = {
        name: fileName,
        parents: [this.imageFolderId]
      };

      const media = {
        mimeType: mimeType,
        body: fs.createReadStream(processedImagePath)
      };

      const file = await this.drive.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id,name,size,webViewLink,mimeType'
      });
      


      // Make file publicly viewable
      await this.drive.permissions.create({
        fileId: file.data.id,
        resource: {
          role: 'reader',
          type: 'anyone'
        }
      });

      // Generate public URL for Google Docs API
      // Use uc export URL which provides direct image access
      const publicUrl = `https://drive.google.com/uc?export=download&id=${file.data.id}`;
      
      const uploadResult = {
        url: publicUrl,
        fileId: file.data.id,
        fileName: fileName,
        size: file.data.size,
        hash: imageHash,
        webViewLink: file.data.webViewLink,
        uploadedAt: new Date().toISOString()
      };

      // Cache in session
      this.uploadedImages.set(imageHash, uploadResult);

      // Save to persistent state
      const currentState = await this.stateManager.loadState();
      await this.stateManager.updateState({
        googleDrive: {
          ...currentState.googleDrive,
          imageFolderId: this.imageFolderId, // Ensure folder ID is always present
          uploadedImages: {
            ...currentState.googleDrive?.uploadedImages,
            [imageHash]: uploadResult
          }
        }
      });


      
      return { ...uploadResult, cached: false };
      
    } catch (error) {
      throw error;
    }
  }

  /**
   * Download and upload remote image
   * @param {string} imageUrl - Remote image URL
   * @returns {Object} - { url, fileId, cached }
   */
  async uploadRemoteImage(imageUrl) {
    try {
      // Generate hash from URL for consistent caching
      const urlHash = crypto.createHash('sha256').update(imageUrl).digest('hex');
      
      // Check session cache first
      if (this.uploadedImages.has(urlHash)) {
        const cachedResult = this.uploadedImages.get(urlHash);
        return { ...cachedResult, cached: true };
      }

      // Check persistent state
      const state = await this.stateManager.loadState();
      const uploadedImage = state.googleDrive?.uploadedImages?.[urlHash];
      
      if (uploadedImage) {
        // Verify image still exists in Drive
        try {
          const file = await this.drive.files.get({
            fileId: uploadedImage.fileId,
            fields: 'id,name,trashed,webViewLink'
          });
          
          if (!file.data.trashed) {
            // Update session cache
            this.uploadedImages.set(urlHash, uploadedImage);
            return { ...uploadedImage, cached: true };
          } else {
            console.log(chalk.yellow(`⚠️ Cached remote image is trashed, re-uploading: ${imageUrl}`));
          }
        } catch (error) {
          console.log(chalk.yellow(`⚠️ Cached remote image not accessible, re-uploading: ${imageUrl}`));
        }
      }

      // Download and upload new image
      console.log(chalk.blue(`📥 Downloading remote image: ${imageUrl}`));
      
      // Download to temp file first to enable SVG conversion
      const tempDir = path.join(this.projectRoot, '.docusaurus', 'temp');
      await fs.ensureDir(tempDir);
      
      // Get file extension from URL or content-type
      const response = await axios.get(imageUrl, { responseType: 'stream' });
      const contentType = response.headers['content-type'];
      const extension = this.getExtensionFromMimeType(contentType) || 
                       path.extname(new URL(imageUrl).pathname) || '.jpg';
      
      const tempFileName = `remote-${urlHash.substring(0, 8)}${extension}`;
      const tempFilePath = path.join(tempDir, tempFileName);
      
      // Save to temp file
      const writer = fs.createWriteStream(tempFilePath);
      response.data.pipe(writer);
      
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      

      
      // FORCE SVG detection from URL path for proper conversion
      const urlPath = new URL(imageUrl).pathname.toLowerCase();
      const isSvgFromUrl = urlPath.endsWith('.svg') || extension === '.svg';
      

      
      // Convert SVG to PNG if needed for Google Docs compatibility
      const processedImagePath = await this.convertImageForGoogleDocs(tempFilePath, isSvgFromUrl ? 'image/svg+xml' : contentType);
      const finalFileName = `remote-${urlHash.substring(0, 8)}${path.extname(processedImagePath)}`;
      const finalMimeType = this.getMimeType(processedImagePath);
      
      console.log(chalk.blue(`📤 Uploading remote image: ${imageUrl}`));
      if (processedImagePath !== tempFilePath) {
        // console.log(chalk.green(`✅ SVG converted to PNG for Google Docs compatibility`));
      }
      
      const fileMetadata = {
        name: finalFileName,
        parents: [this.imageFolderId]
      };

      const media = {
        mimeType: finalMimeType,
        body: fs.createReadStream(processedImagePath)
      };
      


      const file = await this.drive.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id,name,size,webViewLink,mimeType'
      });
      


      // Make file publicly viewable
      await this.drive.permissions.create({
        fileId: file.data.id,
        resource: {
          role: 'reader',
          type: 'anyone'
        }
      });

      // Generate public URL for Google Docs API
      // Use uc export URL which provides direct image access
      const publicUrl = `https://drive.google.com/uc?export=download&id=${file.data.id}`;
      
      const uploadResult = {
        url: publicUrl,
        fileId: file.data.id,
        fileName: finalFileName,
        originalUrl: imageUrl,
        size: file.data.size,
        hash: urlHash,
        webViewLink: file.data.webViewLink,
        uploadedAt: new Date().toISOString()
      };

      // Cleanup temp files
      try {
        if (await fs.pathExists(tempFilePath)) {
          await fs.remove(tempFilePath);
        }
        if (processedImagePath !== tempFilePath && await fs.pathExists(processedImagePath)) {
          await fs.remove(processedImagePath);
        }
      } catch (cleanupError) {
        console.warn(chalk.yellow(`⚠️ Failed to cleanup temp files: ${cleanupError.message}`));
      }

      // Cache in session and save to persistent state
      this.uploadedImages.set(urlHash, uploadResult);
      
      const currentState = await this.stateManager.loadState();
      await this.stateManager.updateState({
        googleDrive: {
          ...currentState.googleDrive,
          imageFolderId: this.imageFolderId, // Ensure folder ID is always present
          uploadedImages: {
            ...currentState.googleDrive?.uploadedImages,
            [urlHash]: uploadResult
          }
        }
      });

      console.log(chalk.green(`✅ Remote image uploaded and cached: ${finalFileName} (${this.formatFileSize(file.data.size)})`));
      return { ...uploadResult, cached: false };
      
    } catch (error) {
      console.error(chalk.red(`❌ Failed to upload remote image ${imageUrl}:`), error.message);
      throw error;
    }
  }

  /**
   * Get MIME type from file extension
   */
  getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.tiff': 'image/tiff'
    };
    return mimeTypes[ext] || 'image/jpeg';
  }

  /**
   * Get file extension from MIME type
   */
  getExtensionFromMimeType(mimeType) {
    const extensions = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/svg+xml': '.svg',
      'image/webp': '.webp',
      'image/bmp': '.bmp',
      'image/tiff': '.tiff'
    };
    return extensions[mimeType] || '.jpg';
  }

  /**
   * Format file size for display
   */
  formatFileSize(bytes) {
    if (!bytes) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  }


  /**
   * Get upload statistics
   */
  getUploadStats() {
    return {
      sessionUploads: this.uploadedImages.size,
      totalCached: Array.from(this.uploadedImages.values()).filter(img => img.cached).length,
      totalNew: Array.from(this.uploadedImages.values()).filter(img => !img.cached).length
    };
  }

  /**
   * Clean up resources
   */
  async cleanup() {
    try {
      // Clear session cache
      this.uploadedImages.clear();
      
  
      
    } catch (error) {
      console.warn(chalk.yellow('⚠️ Google Drive client cleanup warning:', error.message));
    }
  }
}

module.exports = GoogleDriveClient; 