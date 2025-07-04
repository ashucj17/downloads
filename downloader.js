const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const url = require('url');
const readline = require('readline');

class PDFDownloader {
  constructor(downloadDir = 'C:\\Users\\Hp\\Downloads') {
    this.downloadDir = downloadDir;
    this.createDownloadDirectory();
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }

  // Create downloads directory if it doesn't exist
  createDownloadDirectory() {
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
      console.log(`Created download directory: ${this.downloadDir}`);
    }
  }

  // Wait for user input (click/enter)
  waitForUserClick(message = 'Press Enter to continue to next download...') {
    return new Promise((resolve) => {
      console.log(`\n⏸️  ${message}`);
      this.rl.question('', () => {
        resolve();
      });
    });
  }

  // Download a single PDF file
  downloadPDF(fileUrl, fileName = null) {
    return new Promise((resolve, reject) => {
      const parsedUrl = url.parse(fileUrl);
      const protocol = parsedUrl.protocol === 'https:' ? https : http;
      
      // Extract filename from URL if not provided, ensure PDF extension
      if (!fileName) {
        fileName = path.basename(parsedUrl.pathname) || 'downloaded_file';
      }
      
      // Ensure PDF extension
      if (!fileName.toLowerCase().endsWith('.pdf')) {
        fileName += '.pdf';
      }
      
      const filePath = path.join(this.downloadDir, fileName);
      
      console.log(`Starting PDF download: ${fileUrl}`);
      console.log(`Saving to: ${filePath}`);
      
      const request = protocol.get(fileUrl, (response) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          console.log(`Redirecting to: ${response.headers.location}`);
          return this.downloadPDF(response.headers.location, fileName)
            .then(resolve)
            .catch(reject);
        }
        
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download ${fileUrl}. Status: ${response.statusCode}`));
          return;
        }
        
        // Check if content type is PDF
        const contentType = response.headers['content-type'];
        if (contentType && !contentType.includes('application/pdf') && !contentType.includes('application/octet-stream')) {
          console.warn(`Warning: Content type is ${contentType}, not PDF`);
        }
        
        const fileStream = fs.createWriteStream(filePath);
        const totalSize = parseInt(response.headers['content-length'], 10);
        let downloadedSize = 0;
        
        response.on('data', (chunk) => {
          downloadedSize += chunk.length;
          if (totalSize) {
            const progress = ((downloadedSize / totalSize) * 100).toFixed(2);
            process.stdout.write(`\rDownloading ${fileName}: ${progress}%`);
          }
        });
        
        response.pipe(fileStream);
        
        fileStream.on('finish', () => {
          fileStream.close();
          console.log(`\n✅ Downloaded PDF: ${fileName}`);
          console.log(`📁 Saved to: ${filePath}`);
          resolve(filePath);
        });
        
        fileStream.on('error', (err) => {
          fs.unlink(filePath, () => {}); // Delete incomplete file
          reject(err);
        });
      });
      
      request.on('error', (err) => {
        reject(new Error(`Request failed for ${fileUrl}: ${err.message}`));
      });
      
      request.setTimeout(30000, () => {
        request.abort();
        reject(new Error(`Download timeout for ${fileUrl}`));
      });
    });
  }

  // Download multiple PDF files with click-to-continue functionality
  async downloadMultiplePDFsWithClick(pdfList, options = {}) {
    const { retryCount = 2, pauseAfterFirst = true } = options;
    const results = [];
    const failed = [];
    
    console.log(`Starting download of ${pdfList.length} PDF files...`);
    console.log(`Download directory: ${this.downloadDir}`);
    console.log(`Retry attempts: ${retryCount}`);
    console.log('─'.repeat(60));
    
    // Process files one by one with click functionality
    for (let i = 0; i < pdfList.length; i++) {
      const fileInfo = pdfList[i];
      const { url: fileUrl, name: fileName } = typeof fileInfo === 'string' 
        ? { url: fileInfo, name: null } 
        : fileInfo;
      
      console.log(`\n📥 Downloading file ${i + 1}/${pdfList.length}: ${fileName || path.basename(fileUrl)}`);
      
      let lastError;
      let downloadSuccess = false;
      
      for (let attempt = 0; attempt <= retryCount; attempt++) {
        try {
          const filePath = await this.downloadPDF(fileUrl, fileName);
          results.push({ url: fileUrl, fileName, filePath, status: 'success' });
          downloadSuccess = true;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < retryCount) {
            console.log(`\n⚠️  Retry ${attempt + 1}/${retryCount} for ${fileName || fileUrl}`);
            await this.delay(1000 * (attempt + 1)); // Exponential backoff
          }
        }
      }
      
      if (!downloadSuccess) {
        console.log(`\n❌ Failed to download: ${fileName || fileUrl}`);
        console.log(`   Error: ${lastError.message}`);
        failed.push({ url: fileUrl, fileName, error: lastError.message, status: 'failed' });
      }
      
      // Wait for user click after first download and between subsequent downloads
      if (pauseAfterFirst && i === 0 && pdfList.length > 1) {
        await this.waitForUserClick(`First download complete! Press Enter to continue with remaining ${pdfList.length - 1} files...`);
      } else if (i < pdfList.length - 1) {
        await this.waitForUserClick(`Download ${i + 1} complete! Press Enter for next download...`);
      }
    }
    
    this.printSummary(results, failed);
    this.rl.close();
    return { successful: results, failed };
  }

  // Original method without click functionality (for backward compatibility)
  async downloadMultiplePDFs(pdfList, options = {}) {
    const { concurrent = 2, retryCount = 2 } = options;
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
      const batchPromises = batch.map(async (fileInfo) => {
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
        console.log(`   ${index + 1}. ${file.fileName || file.url} - ${file.error}`);
      });
    }
    
    console.log('\n' + '='.repeat(60));
  }

  // Save content as PDF (basic text to PDF - requires additional libraries for proper PDF generation)
  saveTextAsPDF(content, fileName) {
    // Note: This is a basic implementation. For proper PDF generation, use libraries like:
    // - PDFKit
    // - jsPDF
    // - Puppeteer (for HTML to PDF)
    
    console.log('⚠️  Note: This saves as text file with .pdf extension');
    console.log('⚠️  For proper PDF generation, use PDFKit, jsPDF, or Puppeteer');
    
    const filePath = path.join(this.downloadDir, fileName.endsWith('.pdf') ? fileName : fileName + '.pdf');
    
    try {
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`✅ Saved content to: ${fileName}`);
      return filePath;
    } catch (error) {
      console.error(`❌ Failed to save ${fileName}: ${error.message}`);
      throw error;
    }
  }

  // Cleanup method to close readline interface
  cleanup() {
    if (this.rl) {
      this.rl.close();
    }
  }
}

// Example usage
async function main() {
  const downloader = new PDFDownloader();
  
  // Example PDF URLs (replace with your actual PDF URLs)
  const pdfUrls = [
    { url: 'https://github.com/ashucj17/downloads/blob/main/kumar.pdf', name: 'kumar.pdf' },
    { url: 'https://github.com/ashucj17/downloads/blob/main/biodata.pdf', name: 'biodata.pdf' },
    { url: 'https://github.com/ashucj17/downloads/blob/main/gupta-5year.pdf', name: 'gupta-5year.pdf' },
    // Add your PDF URLs here
  ];
  
  try {
    console.log('🚀 Starting PDF download process with click-to-continue...\n');
    
    // NEW: Download with click functionality
    await downloader.downloadMultiplePDFsWithClick(pdfUrls, {
      retryCount: 2,
      pauseAfterFirst: true // Set to false if you want to pause after every download
    });
    
    // Alternative: Use original method without click functionality
    // await downloader.downloadMultiplePDFs(pdfUrls, {
    //   concurrent: 2,
    //   retryCount: 2
    // });
    
    console.log('\n🎉 PDF download process completed!');
    console.log(`📂 Check your downloads folder: ${downloader.downloadDir}`);
    
  } catch (error) {
    console.error('❌ PDF download failed:', error.message);
  } finally {
    // Cleanup readline interface
    downloader.cleanup();
  }
}

// Handle process termination gracefully
process.on('SIGINT', () => {
  console.log('\n\n👋 Download process interrupted by user');
  process.exit(0);
});

// Run the program
if (require.main === module) {
  main();
}

module.exports = PDFDownloader;