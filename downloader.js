const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const url = require('url');
const crypto = require('crypto');

class PDFDownloader {
  constructor(downloadDir = 'downloads') {
    this.downloadDir = path.resolve(downloadDir);
    this.createDownloadDirectory();
    this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
  }

  // Create downloads directory if it doesn't exist
  createDownloadDirectory() {
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
      console.log(`Created download directory: ${this.downloadDir}`);
    }
  }

  // Validate if the file is actually a PDF by checking magic bytes
  validatePDF(filePath) {
    try {
      const buffer = fs.readFileSync(filePath, { start: 0, end: 4 });
      const pdfMagic = buffer.toString('ascii', 0, 4);
      return pdfMagic === '%PDF';
    } catch (error) {
      console.warn(`Could not validate PDF: ${error.message}`);
      return false;
    }
  }

  // Generate a safe filename
  generateSafeFilename(originalName) {
    const sanitized = originalName.replace(/[<>:"/\\|?*]/g, '_');
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    
    if (!sanitized.toLowerCase().endsWith('.pdf')) {
      return `${sanitized}_${timestamp}_${random}.pdf`;
    }
    
    const nameWithoutExt = sanitized.substring(0, sanitized.lastIndexOf('.'));
    return `${nameWithoutExt}_${timestamp}_${random}.pdf`;
  }

  // Download a single PDF file
  downloadPDF(fileUrl, fileName = null) {
    return new Promise((resolve, reject) => {
      try {
        const parsedUrl = url.parse(fileUrl);
        
        // Validate URL
        if (!parsedUrl.protocol || !parsedUrl.hostname) {
          reject(new Error(`Invalid URL: ${fileUrl}`));
          return;
        }

        // Only support HTTP/HTTPS protocols
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          reject(new Error(`Unsupported protocol: ${parsedUrl.protocol}. Only HTTP/HTTPS are supported.`));
          return;
        }

        const protocol = parsedUrl.protocol === 'https:' ? https : http;
        
        // Extract filename from URL if not provided
        if (!fileName) {
          fileName = path.basename(parsedUrl.pathname) || 'downloaded_file';
          // Remove query parameters from filename
          fileName = fileName.split('?')[0];
        }
        
        // Generate safe filename
        const safeFileName = this.generateSafeFilename(fileName);
        const filePath = path.join(this.downloadDir, safeFileName);
        
        console.log(`Starting PDF download: ${fileUrl}`);
        console.log(`Saving to: ${filePath}`);
        
        const options = {
          ...parsedUrl,
          headers: {
            'User-Agent': this.userAgent,
            'Accept': 'application/pdf,application/octet-stream,*/*',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive'
          }
        };

        const request = protocol.get(options, (response) => {
          // Handle redirects
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            console.log(`Redirecting to: ${response.headers.location}`);
            return this.downloadPDF(response.headers.location, fileName)
              .then(resolve)
              .catch(reject);
          }
          
          if (response.statusCode !== 200) {
            reject(new Error(`Failed to download ${fileUrl}. Status: ${response.statusCode} ${response.statusMessage}`));
            return;
          }
          
          // Check content type
          const contentType = response.headers['content-type'];
          if (contentType && !contentType.includes('application/pdf') && 
              !contentType.includes('application/octet-stream') && 
              !contentType.includes('binary/octet-stream')) {
            console.warn(`Warning: Content type is ${contentType}, expected PDF`);
          }
          
          const fileStream = fs.createWriteStream(filePath);
          const totalSize = parseInt(response.headers['content-length'], 10);
          let downloadedSize = 0;
          let lastProgress = 0;
          
          response.on('data', (chunk) => {
            downloadedSize += chunk.length;
            if (totalSize) {
              const progress = Math.floor((downloadedSize / totalSize) * 100);
              // Only update progress every 5% to reduce console spam
              if (progress - lastProgress >= 5) {
                process.stdout.write(`\rDownloading ${safeFileName}: ${progress}%`);
                lastProgress = progress;
              }
            }
          });
          
          response.pipe(fileStream);
          
          fileStream.on('finish', () => {
            fileStream.close();
            console.log(`\n✅ Downloaded: ${safeFileName}`);
            
            // Validate PDF
            if (this.validatePDF(filePath)) {
              console.log(`📄 PDF validation: PASSED`);
              console.log(`📁 Saved to: ${filePath}`);
              resolve(filePath);
            } else {
              console.warn(`⚠️  PDF validation: FAILED - File may be corrupted or not a valid PDF`);
              console.log(`📁 Saved to: ${filePath}`);
              resolve(filePath); // Still resolve, let user decide
            }
          });
          
          fileStream.on('error', (err) => {
            fs.unlink(filePath, () => {}); // Delete incomplete file
            reject(err);
          });
        });
        
        request.on('error', (err) => {
          reject(new Error(`Request failed for ${fileUrl}: ${err.message}`));
        });
        
        request.setTimeout(60000, () => {
          request.destroy();
          reject(new Error(`Download timeout for ${fileUrl}`));
        });
        
      } catch (error) {
        reject(error);
      }
    });
  }

  // Download multiple PDF files
  async downloadMultiplePDFs(pdfList, options = {}) {
    const { concurrent = 3, retryCount = 3, delayBetweenBatches = 1000 } = options;
    const results = [];
    const failed = [];
    
    console.log(`Starting download of ${pdfList.length} PDF files...`);
    console.log(`Download directory: ${this.downloadDir}`);
    console.log(`Concurrent downloads: ${concurrent}`);
    console.log(`Retry attempts: ${retryCount}`);
    console.log('─'.repeat(60));
    
    // Process files in batches
    for (let i = 0; i < pdfList.length; i += concurrent) {
      const batch = pdfList.slice(i, i + concurrent);
      const batchNumber = Math.floor(i / concurrent) + 1;
      const totalBatches = Math.ceil(pdfList.length / concurrent);
      
      console.log(`\n📦 Processing batch ${batchNumber}/${totalBatches} (${batch.length} files)...`);
      
      const batchPromises = batch.map(async (fileInfo, index) => {
        const { url: fileUrl, name: fileName } = typeof fileInfo === 'string' 
          ? { url: fileInfo, name: null } 
          : fileInfo;
        
        let lastError;
        for (let attempt = 0; attempt <= retryCount; attempt++) {
          try {
            const filePath = await this.downloadPDF(fileUrl, fileName);
            return { url: fileUrl, fileName, filePath, status: 'success' };
          } catch (error) {
            lastError = error;
            if (attempt < retryCount) {
              console.log(`\n⚠️  Retry ${attempt + 1}/${retryCount} for ${fileName || fileUrl}`);
              await this.delay(1000 * (attempt + 1)); // Exponential backoff
            }
          }
        }
        
        console.log(`\n❌ Failed to download: ${fileName || fileUrl}`);
        console.log(`   Error: ${lastError.message}`);
        return { url: fileUrl, fileName, error: lastError.message, status: 'failed' };
      });
      
      const batchResults = await Promise.allSettled(batchPromises);
      batchResults.forEach(result => {
        if (result.status === 'fulfilled') {
          if (result.value.status === 'success') {
            results.push(result.value);
          } else {
            failed.push(result.value);
          }
        } else {
          failed.push({ error: result.reason.message, status: 'failed' });
        }
      });
      
      // Delay between batches to be respectful to servers
      if (i + concurrent < pdfList.length && delayBetweenBatches > 0) {
        console.log(`\n⏳ Waiting ${delayBetweenBatches}ms before next batch...`);
        await this.delay(delayBetweenBatches);
      }
    }
    
    this.printSummary(results, failed);
    return { successful: results, failed };
  }

  // Utility function for delays
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Print download summary
  printSummary(successful, failed) {
    console.log('\n' + '='.repeat(60));
    console.log('📊 PDF DOWNLOAD SUMMARY');
    console.log('='.repeat(60));
    console.log(`✅ Successful downloads: ${successful.length}`);
    console.log(`❌ Failed downloads: ${failed.length}`);
    console.log(`📁 Download directory: ${this.downloadDir}`);
    
    if (successful.length > 0) {
      console.log('\n📥 Successfully downloaded PDFs:');
      successful.forEach((file, index) => {
        console.log(`   ${index + 1}. ${file.fileName || path.basename(file.url)}`);
        console.log(`      → ${file.filePath}`);
      });
    }
    
    if (failed.length > 0) {
      console.log('\n❌ Failed downloads:');
      failed.forEach((file, index) => {
        console.log(`   ${index + 1}. ${file.fileName || file.url}`);
        console.log(`      → Error: ${file.error}`);
      });
    }
    
    console.log('\n' + '='.repeat(60));
  }

  // Get download statistics
  getStats() {
    const files = fs.readdirSync(this.downloadDir);
    const pdfFiles = files.filter(file => file.toLowerCase().endsWith('.pdf'));
    const totalSize = pdfFiles.reduce((size, file) => {
      const filePath = path.join(this.downloadDir, file);
      const stats = fs.statSync(filePath);
      return size + stats.size;
    }, 0);
    
    return {
      totalFiles: pdfFiles.length,
      totalSize: totalSize,
      formattedSize: this.formatBytes(totalSize),
      files: pdfFiles
    };
  }

  // Format bytes to human readable format
  formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  // Clean up failed downloads
  cleanupFailedDownloads() {
    const files = fs.readdirSync(this.downloadDir);
    let cleaned = 0;
    
    files.forEach(file => {
      const filePath = path.join(this.downloadDir, file);
      const stats = fs.statSync(filePath);
      
      // Remove empty files or files smaller than 100 bytes (likely failed downloads)
      if (stats.size < 100) {
        fs.unlinkSync(filePath);
        console.log(`🗑️  Removed failed download: ${file}`);
        cleaned++;
      }
    });
    
    console.log(`🧹 Cleaned up ${cleaned} failed downloads`);
  }
}

// Example usage
async function main() {
  const downloader = new PDFDownloader('./downloads');
  
  // Example PDF URLs (replace with your actual PDF URLs)
  const pdfUrls = [
    { url: 'https://drive.google.com/drive/u/0/my-drive/OfferLetter.pdf', name: 'OfferLetter.pdf' },
    { url: 'https://www.adobe.com/support/products/enterprise/knowledgecenter/media/c4611_sample_explain.pdf', name: 'adobe_sample.pdf' },
    // Add your actual PDF URLs here
  ];
  
  try {
    console.log('🚀 Starting PDF download process...\n');
    
    // Download multiple PDFs
    const results = await downloader.downloadMultiplePDFs(pdfUrls, {
      concurrent: 2,
      retryCount: 3,
      delayBetweenBatches: 1000
    });
    
    console.log('\n📊 Final Statistics:');
    const stats = downloader.getStats();
    console.log(`Total PDFs: ${stats.totalFiles}`);
    console.log(`Total Size: ${stats.formattedSize}`);
    
    console.log('\n🎉 PDF download process completed!');
    console.log(`📂 Check your downloads folder: ${downloader.downloadDir}`);
    
    // Clean up any failed downloads
    downloader.cleanupFailedDownloads();
    
  } catch (error) {
    console.error('❌ PDF download failed:', error.message);
  }
}

// Run the program
if (require.main === module) {
  main();
}

module.exports = PDFDownloader;