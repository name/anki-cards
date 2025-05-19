const fs = require('fs');
const path = require('path');

// Define source directory (your build output)
const sourceDir = path.join(__dirname);

// Define target directory (your Obsidian plugins folder)
const targetDir = path.join('C:', 'Users', 'char', 'Documents', 'GitHub', 'Rodin', '.obsidian', 'plugins', 'obsidian-anki');

// Ensure the target directory exists
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
  console.log(`Created target directory: ${targetDir}`);
}

// Files to copy
const filesToCopy = ['main.js', 'manifest.json', 'styles.css'].filter(file =>
  fs.existsSync(path.join(sourceDir, file))
);

// Copy each file
filesToCopy.forEach(file => {
  const sourcePath = path.join(sourceDir, file);
  const targetPath = path.join(targetDir, file);

  fs.copyFileSync(sourcePath, targetPath);
  console.log(`Copied: ${file} to ${targetPath}`);
});

console.log('Copy complete!');
