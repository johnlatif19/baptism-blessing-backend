// ==================== TENSORFLOW SETUP ====================
const tf = require('@tensorflow/tfjs-node');
console.log(`🧠 TensorFlow.js version: ${tf.version_core}`);

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { body, validationResult } = require('express-validator');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

// ==================== FACE RECOGNITION SETUP ====================
const faceapi = require('@vladmandic/face-api');
const canvas = require('canvas');

// Configure face-api to use canvas
const { Canvas, Image, ImageData } = canvas;
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

let faceDetectionModelLoaded = false;

// Face match threshold - easy to adjust
const FACE_MATCH_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD || 0.6);

// Load face detection models on startup
async function loadFaceModels() {
    try {
        console.log('🔄 Loading face detection models from CDN...');
        
        const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model';
        
        await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
        await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
        await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
        
        faceDetectionModelLoaded = true;
        console.log('✅ Face detection models loaded successfully from CDN');
    } catch (error) {
        console.error('❌ Failed to load face detection models:', error.message);
        console.log('⚠️ Face recognition features will be disabled');
    }
}

// ==================== INITIALIZATION ====================

// Validate required environment variables
const requiredEnvVars = [
  'JWT_SECRET',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'FIREBASE_CONFIG',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD'
];

const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingEnvVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingEnvVars.join(', ')}`);
  console.error('Please check your environment variables on Railway');
  process.exit(1);
}

// Initialize Firebase Admin from FIREBASE_CONFIG environment variable
let firebaseConfig;
try {
  firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
  console.log('✅ Firebase config loaded successfully');
} catch (error) {
  console.error('❌ Invalid FIREBASE_CONFIG JSON format:', error.message);
  console.error('Make sure FIREBASE_CONFIG contains the full JSON service account key');
  process.exit(1);
}

// Initialize Firebase Admin
try {
  admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig)
  });
  console.log('✅ Firebase Admin initialized successfully');
} catch (error) {
  console.error('❌ Failed to initialize Firebase Admin:', error.message);
  process.exit(1);
}

const db = admin.firestore();

// Initialize Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});
console.log('✅ Cloudinary configured successfully');

// ==================== EXPRESS APP ====================

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== MIDDLEWARE ====================

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://api.qrserver.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https://res.cloudinary.com", "https://api.qrserver.com"],
      frameSrc: ["'self'", "https://www.google.com", "https://www.youtube.com"],
      connectSrc: ["'self'", "https://baptism-blessing-backend.up.railway.app"],
    },
  },
  crossOriginEmbedderPolicy: false
}));

// CORS
app.use(cors({
  origin: function (origin, callback) {
    const allowedOrigins = [
      'https://baptism-blessing.vercel.app',
      'https://*.vercel.app',
      'https://baptism-blessing-backend.up.railway.app',
      'http://localhost:3000',
      'http://localhost:5500'
    ];
    
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.some(allowed => origin.includes(allowed.replace('*.', '')))) {
      callback(null, true);
    } else {
      console.log('❌ CORS blocked:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Authorization']
}));

// Handle preflight requests
app.options('*', cors());

// Compression
app.use(compression());

// JSON and URL encoded
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// ==================== RATE LIMITING ====================

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many authentication attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/login', authLimiter);

// ==================== MULTER CONFIGURATION ====================

const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 500 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
      'video/mp4', 'video/mpeg', 'video/quicktime', 'video/x-msvideo', 'video/webm'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image and video files are allowed'), false);
    }
  }
});

// ==================== JWT CONFIGURATION ====================

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// ==================== AUTHENTICATION MIDDLEWARE ====================

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Access token required' });
  }

  try {
    const user = jwt.verify(token, JWT_SECRET);
    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(403).json({ message: 'Token expired' });
    }
    return res.status(403).json({ message: 'Invalid token' });
  }
};

// ==================== FACE RECOGNITION HELPER FUNCTIONS ====================

/**
 * Extract all face descriptors from an image
 * Uses detectAllFaces to handle multiple faces
 */
async function extractAllFaceDescriptors(imageBuffer) {
    if (!faceDetectionModelLoaded) {
        throw new Error('Face detection models not loaded');
    }

    try {
        const img = new Image();
        img.src = imageBuffer;
        
        const detections = await faceapi.detectAllFaces(img)
            .withFaceLandmarks()
            .withFaceDescriptors();

        if (!detections || detections.length === 0) {
            return { descriptors: [], count: 0 };
        }

        const descriptors = detections.map(det => Array.from(det.descriptor));
        return { descriptors, count: detections.length };
    } catch (error) {
        throw new Error(`Face detection failed: ${error.message}`);
    }
}

/**
 * Calculate match percentage from distance
 */
function calculateMatchPercentage(distance) {
    if (distance === Infinity || distance > FACE_MATCH_THRESHOLD) {
        return 0;
    }
    const percentage = Math.round((1 - distance / FACE_MATCH_THRESHOLD) * 100);
    return Math.max(0, Math.min(100, percentage));
}

/**
 * Compare a face descriptor against multiple gallery descriptors
 * Returns the best match with distance and percentage
 */
function compareFaceAgainstGallery(targetDescriptor, galleryDescriptors) {
    let bestDistance = Infinity;
    let bestMatchIndex = -1;

    // Ensure galleryDescriptors is an array
    const descriptorsArray = Array.isArray(galleryDescriptors) ? galleryDescriptors : [galleryDescriptors];

    for (let i = 0; i < descriptorsArray.length; i++) {
        const galleryDesc = descriptorsArray[i];
        if (!galleryDesc || !Array.isArray(galleryDesc) || galleryDesc.length === 0) continue;
        
        try {
            const distance = faceapi.euclideanDistance(targetDescriptor, galleryDesc);
            if (distance < bestDistance) {
                bestDistance = distance;
                bestMatchIndex = i;
            }
        } catch (error) {
            console.warn('Error calculating distance:', error.message);
            continue;
        }
    }

    return {
        distance: bestDistance,
        matchPercentage: calculateMatchPercentage(bestDistance),
        isMatch: bestDistance < FACE_MATCH_THRESHOLD && bestDistance !== Infinity
    };
}

// ==================== API ROUTES ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    faceRecognition: faceDetectionModelLoaded ? 'enabled' : 'disabled',
    tensorflow: tf.version_core || 'unknown'
  });
});

// ==================== AUTH ROUTES ====================

app.post('/api/login', [
  body('username').notEmpty().withMessage('Username is required').trim().escape(),
  body('password').notEmpty().withMessage('Password is required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: errors.array()[0].msg });
  }

  const { username, password, rememberMe } = req.body;

  try {
    const userSnapshot = await db.collection('users')
      .where('username', '==', username)
      .limit(1)
      .get();

    let userData = null;

    if (!userSnapshot.empty) {
      userData = userSnapshot.docs[0].data();
    }

    if (!userData) {
      if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const adminCheck = await db.collection('users')
          .where('username', '==', ADMIN_USERNAME)
          .limit(1)
          .get();

        if (adminCheck.empty) {
          const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 10);
          await db.collection('users').add({
            username: ADMIN_USERNAME,
            password: hashedPassword,
            role: 'admin',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }

        const token = jwt.sign(
          { username: ADMIN_USERNAME, role: 'admin' },
          JWT_SECRET,
          { expiresIn: rememberMe ? '30d' : '24h' }
        );

        return res.json({ 
          token, 
          message: 'Login successful',
          user: { username: ADMIN_USERNAME, role: 'admin' }
        });
      }
      
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    const isValidPassword = await bcrypt.compare(password, userData.password);
    if (!isValidPassword) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    const token = jwt.sign(
      { username: userData.username, role: userData.role || 'admin' },
      JWT_SECRET,
      { expiresIn: rememberMe ? '30d' : '24h' }
    );

    res.json({ 
      token, 
      message: 'Login successful',
      user: { username: userData.username, role: userData.role || 'admin' }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error during login' });
  }
});

app.post('/api/logout', authenticateToken, (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

// ==================== GALLERY ROUTES ====================

app.get('/api/gallery', async (req, res) => {
  try {
    const snapshot = await db.collection('gallery')
      .orderBy('createdAt', 'desc')
      .get();
    
    const images = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      images.push({ 
        id: doc.id, 
        ...data,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
      });
    });
    res.json(images);
  } catch (error) {
    console.error('Error fetching gallery:', error);
    res.status(500).json({ message: 'Error fetching gallery' });
  }
});

app.post('/api/gallery', authenticateToken, upload.single('image'), async (req, res) => {
  if (!req.user) {
    console.error('❌ No user found in request');
    return res.status(401).json({ message: 'Authentication failed' });
  }
  
  console.log(`👤 User: ${req.user.username || req.user.role || 'Unknown'}`);
  
  if (!req.file) {
    return res.status(400).json({ message: 'No image file provided' });
  }

  try {
    console.log('📤 Uploading image to Cloudinary...');
    console.log(`📁 File: ${req.file.originalname}, Size: ${(req.file.size / 1024).toFixed(2)} KB`);
    
    // Upload to Cloudinary
    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'baptism-blessing/gallery',
          transformation: [
            { width: 1920, crop: 'limit', quality: 'auto' }
          ],
          public_id: `gallery_${uuidv4()}`
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(req.file.buffer);
    });

    console.log('✅ Cloudinary upload successful');

    let faceDescriptors = null;
    let hasFace = false;

    // Try to detect faces
    if (faceDetectionModelLoaded) {
      try {
        console.log('🔍 Detecting faces in image...');
        const extractionResult = await extractAllFaceDescriptors(req.file.buffer);
        if (extractionResult.count > 0) {
          // ✅ تخزين المصفوفات مباشرة بدون كائنات
          faceDescriptors = extractionResult.descriptors;
          hasFace = true;
          console.log(`✅ ${extractionResult.count} face(s) detected and stored`);
        } else {
          console.warn('⚠️ No face detected in image');
        }
      } catch (faceError) {
        console.warn('⚠️ Face detection error:', faceError.message);
      }
    } else {
      console.warn('⚠️ Face detection models not loaded');
    }

    // Prepare image data
    const imageData = {
      url: result.secure_url,
      publicId: result.public_id,
      title: req.body.title || 'Image',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      hasFace: hasFace
    };

    // ✅ تخزين الـ faceDescriptors كمصفوفة عادية
    if (faceDescriptors && faceDescriptors.length > 0) {
      imageData.faceDescriptors = faceDescriptors;
    }

    // Save to Firestore
    console.log('💾 Saving to Firestore...');
    const docRef = await db.collection('gallery').add(imageData);
    console.log('✅ Image saved to Firestore with ID:', docRef.id);
    
    res.status(201).json({ 
      message: 'Image uploaded successfully',
      id: docRef.id,
      url: result.secure_url,
      publicId: result.public_id,
      title: imageData.title,
      hasFace: hasFace,
      facesDetected: faceDescriptors ? faceDescriptors.length : 0
    });
  } catch (error) {
    console.error('❌ Error uploading image:', error);
    res.status(500).json({ 
      message: 'Error uploading image',
      error: error.message 
    });
  }
});

app.delete('/api/gallery/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const doc = await db.collection('gallery').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ message: 'Image not found' });
    }

    const imageData = doc.data();
    
    if (imageData.publicId) {
      await cloudinary.uploader.destroy(imageData.publicId);
    }

    await db.collection('gallery').doc(id).delete();
    res.json({ message: 'Image deleted successfully' });
  } catch (error) {
    console.error('Error deleting image:', error);
    res.status(500).json({ message: 'Error deleting image' });
  }
});

// ==================== FACE RECOGNITION ROUTES ====================

app.get('/api/face-descriptors', async (req, res) => {
  try {
    const snapshot = await db.collection('gallery')
      .select('url', 'faceDescriptors', 'title')
      .get();
    
    const faceData = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      const descriptors = data.faceDescriptors;
      
      if (descriptors && Array.isArray(descriptors) && descriptors.length > 0) {
        // ✅ استخدم المصفوفة كما هي
        faceData.push({
          id: doc.id,
          url: data.url,
          title: data.title || 'Image',
          faceDescriptors: descriptors
        });
      }
    });
    
    res.json(faceData);
  } catch (error) {
    console.error('Error fetching face descriptors:', error);
    res.status(500).json({ message: 'Error fetching face descriptors' });
  }
});

app.post('/api/face/extract', authenticateToken, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No image file provided' });
  }

  try {
    const extractionResult = await extractAllFaceDescriptors(req.file.buffer);
    
    if (extractionResult.count === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'No face detected in the image' 
      });
    }
    
    res.json({ 
      success: true, 
      descriptors: extractionResult.descriptors,
      facesDetected: extractionResult.count,
      message: `Face descriptor(s) extracted successfully (${extractionResult.count} face(s) found)`
    });
  } catch (error) {
    console.error('Error extracting face descriptors:', error);
    res.status(400).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// ✅✅✅ ENDPOINT البحث المعدل ✅✅✅
app.post('/api/face/search', upload.single('faceImage'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No image file provided' });
  }

  try {
    if (!faceDetectionModelLoaded) {
      return res.status(503).json({ 
        success: false, 
        message: 'Face recognition is currently unavailable. Please try again later.' 
      });
    }

    console.log('🔍 Processing face search...');

    // استخراج الوجوه من صورة البحث (يجب أن تكون فردية)
    const extractionResult = await extractAllFaceDescriptors(req.file.buffer);
    
    // ✅ التحقق: يجب أن يكون وجه واحد فقط في صورة البحث
    if (extractionResult.count === 0) {
      return res.status(400).json({
        success: false,
        message: '⚠️ No face detected in the image. Please upload a clear photo with one face.'
      });
    }
    
    if (extractionResult.count > 1) {
      return res.status(400).json({
        success: false,
        message: '⚠️ Please upload a photo containing only ONE face for search.'
      });
    }

    const targetDescriptor = extractionResult.descriptors[0];
    
    // جلب كل الصور من المعرض
    const snapshot = await db.collection('gallery')
      .select('url', 'faceDescriptors', 'title')
      .get();
    
    const matches = [];
    
    snapshot.forEach(doc => {
      const data = doc.data();
      let galleryDescriptors = data.faceDescriptors;
      
      if (!galleryDescriptors || !Array.isArray(galleryDescriptors) || galleryDescriptors.length === 0) {
        return;
      }
      
      // ✅ جميع الوجوه في الصورة جاهزة للمقارنة
      const comparisonResult = compareFaceAgainstGallery(targetDescriptor, galleryDescriptors);
      
      if (comparisonResult.isMatch) {
        matches.push({
          id: doc.id,
          url: data.url,
          title: data.title || 'Image',
          distance: Math.round(comparisonResult.distance * 10000) / 10000,
          matchPercentage: comparisonResult.matchPercentage
        });
      }
    });

    // ترتيب النتائج (الأقرب أولاً)
    matches.sort((a, b) => a.distance - b.distance);

    console.log(`✅ Search complete: ${matches.length} matches found`);

    res.json({
      success: true,
      matches: matches,
      count: matches.length,
      threshold: FACE_MATCH_THRESHOLD,
      message: matches.length > 0 ? `✅ ${matches.length} matching face(s) found!` : '❌ No matching faces found.'
    });
  } catch (error) {
    console.error('Error searching for faces:', error);
    res.status(400).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// ==================== VIDEO ROUTES ====================

app.get('/api/videos', async (req, res) => {
  try {
    const snapshot = await db.collection('videos')
      .orderBy('createdAt', 'desc')
      .get();
    
    const videos = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      videos.push({ 
        id: doc.id, 
        ...data,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
      });
    });
    res.json(videos);
  } catch (error) {
    console.error('Error fetching videos:', error);
    res.status(500).json({ message: 'Error fetching videos' });
  }
});

app.post('/api/video', authenticateToken, [
    body('url').isURL().withMessage('Valid URL is required'),
    body('publicId').optional().isString(),
    body('title').optional().isString().trim(),
    body('description').optional().isString().trim()
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ message: errors.array()[0].msg });
    }

    try {
        const videoData = {
            url: req.body.url,
            publicId: req.body.publicId || '',
            title: req.body.title || 'Video',
            description: req.body.description || '',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };

        const docRef = await db.collection('videos').add(videoData);
        res.status(201).json({ 
            message: 'Video added successfully',
            id: docRef.id,
            ...videoData
        });
    } catch (error) {
        console.error('Error saving video:', error);
        res.status(500).json({ message: 'Error saving video' });
    }
});

app.delete('/api/video/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const doc = await db.collection('videos').doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ message: 'Video not found' });
    }

    const videoData = doc.data();
    
    if (videoData.publicId) {
      await cloudinary.uploader.destroy(videoData.publicId, { resource_type: 'video' });
    }

    await db.collection('videos').doc(id).delete();
    res.json({ message: 'Video deleted successfully' });
  } catch (error) {
    console.error('Error deleting video:', error);
    res.status(500).json({ message: 'Error deleting video' });
  }
});

// ==================== START SERVER ====================

// Load face models before starting server
loadFaceModels().then(() => {
  app.listen(PORT, () => {
    console.log('=================================');
    console.log('🕊️  Baptism Blessing Server');
    console.log('=================================');
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📱 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🧠 Face Recognition: ${faceDetectionModelLoaded ? '✅ Enabled' : '❌ Disabled'}`);
    console.log(`🧮 TensorFlow: ${tf.version_core || 'unknown'}`);
    console.log(`🎯 Face Match Threshold: ${FACE_MATCH_THRESHOLD}`);
    console.log('=================================');
    console.log('📹 Video upload limit: 500MB');
    console.log('=================================');
  });
});

module.exports = app;
