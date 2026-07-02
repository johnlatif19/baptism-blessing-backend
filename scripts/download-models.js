const fs = require('fs');
const path = require('path');
const https = require('https');

const modelsDir = path.join(__dirname, 'models');

// Create models directory if it doesn't exist
if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
}

const models = [
    'ssd_mobilenetv1_model-weights_manifest.json',
    'ssd_mobilenetv1_model-shard1',
    'ssd_mobilenetv1_model-shard2',
    'face_landmark_68_model-weights_manifest.json',
    'face_landmark_68_model-shard1',
    'face_recognition_model-weights_manifest.json',
    'face_recognition_model-shard1',
    'face_recognition_model-shard2'
];

const baseUrl = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/';

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        console.log(`📥 Downloading ${path.basename(dest)}...`);
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                console.log(`✅ Downloaded ${path.basename(dest)}`);
                resolve();
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
}

async function downloadModels() {
    console.log('📦 Downloading face recognition models...');
    
    for (const model of models) {
        const url = baseUrl + model;
        const dest = path.join(modelsDir, model);
        
        // Check if file already exists
        if (fs.existsSync(dest)) {
            console.log(`⏭️  ${model} already exists, skipping`);
            continue;
        }
        
        try {
            await downloadFile(url, dest);
        } catch (error) {
            console.error(`❌ Failed to download ${model}:`, error.message);
        }
    }
    
    console.log('✅ All models downloaded successfully!');
}

downloadModels().catch(console.error);
