// ==================== TENSORFLOW SETUP ====================
// ✅ لازم يكون قبل face-api
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

// Load face detection models on startup
async function loadFaceModels() {
    try {
        console.log('🔄 Loading face detection models from CDN...');
        
        // ✅ استخدام CDN بدل الملفات المحلية
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
  // FIREBASE_CONFIG is the JSON service account key
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
// CORS - عدل القسم ده
app.use(cors({
  origin: function (origin, callback) {
    const allowedOrigins = [
      'https://baptism-blessing.vercel.app',
      'https://*.vercel.app',
      'https://baptism-blessing-backend.up.railway.app',
      'http://localhost:3000',
      'http://localhost:5500'
    ];
    
    // Allow requests with no origin (like mobile apps or curl requests)
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

async function extractFaceDescriptor(imageBuffer) {
    if (!faceDetectionModelLoaded) {
        throw new Error('Face detection models not loaded');
    }

    try {
        const img = new Image();
        img.src = imageBuffer;
        
        const detections = await faceapi.detectSingleFace(img)
            .withFaceLandmarks()
            .withFaceDescriptor();

        if (!detections) {
            throw new Error('No face detected in the image');
        }

        return Array.from(detections.descriptor);
    } catch (error) {
        throw new Error(`Face detection failed: ${error.message}`);
    }
}

function compareFaces(descriptor1, descriptor2) {
    let sum = 0;
    for (let i = 0; i < descriptor1.length; i++) {
        sum += Math.pow(descriptor1[i] - descriptor2[i], 2);
    }
    const distance = Math.sqrt(sum);
    const similarity = Math.max(0, 1 - (distance / 1.4));
    return Math.min(1, similarity);
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
  if (!req.file) {
    return res.status(400).json({ message: 'No image file provided' });
  }

  try {
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

    let faceDescriptor = null;
    if (faceDetectionModelLoaded) {
      try {
        faceDescriptor = await extractFaceDescriptor(req.file.buffer);
        console.log('✅ Face descriptor extracted successfully');
      } catch (faceError) {
        console.warn('⚠️ No face detected:', faceError.message);
      }
    }

    const imageData = {
      url: result.secure_url,
      publicId: result.public_id,
      title: req.body.title || 'Image',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      hasFace: faceDescriptor !== null
    };

    if (faceDescriptor) {
      imageData.faceDescriptor = faceDescriptor;
    }

    const docRef = await db.collection('gallery').add(imageData);
    
    res.status(201).json({ 
      message: 'Image uploaded successfully',
      id: docRef.id,
      url: result.secure_url,
      publicId: result.public_id,
      title: imageData.title,
      hasFace: faceDescriptor !== null,
      faceDetected: faceDescriptor !== null
    });
  } catch (error) {
    console.error('Error uploading image:', error);
    res.status(500).json({ message: 'Error uploading image' });
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
      .select('url', 'faceDescriptor', 'title')
      .get();
    
    const faceData = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.faceDescriptor && data.faceDescriptor.length > 0) {
        faceData.push({
          id: doc.id,
          url: data.url,
          title: data.title || 'Image',
          faceDescriptor: data.faceDescriptor
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
    const descriptor = await extractFaceDescriptor(req.file.buffer);
    res.json({ 
      success: true, 
      descriptor: descriptor,
      message: 'Face descriptor extracted successfully'
    });
  } catch (error) {
    console.error('Error extracting face descriptor:', error);
    res.status(400).json({ 
      success: false, 
      message: error.message 
    });
  }
});

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

    const targetDescriptor = await extractFaceDescriptor(req.file.buffer);
    
    const snapshot = await db.collection('gallery')
      .select('url', 'faceDescriptor', 'title')
      .get();
    
    const matches = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.faceDescriptor && data.faceDescriptor.length > 0) {
        const similarity = compareFaces(targetDescriptor, data.faceDescriptor);
        if (similarity > 0.65) {
          matches.push({
            id: doc.id,
            url: data.url,
            title: data.title || 'Image',
            similarity: Math.round(similarity * 100) / 100
          });
        }
      }
    });

    matches.sort((a, b) => b.similarity - a.similarity);

    res.json({
      success: true,
      matches: matches,
      count: matches.length,
      message: matches.length > 0 ? 'Faces found!' : 'No matching faces found'
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
    console.log('=================================');
    console.log('📹 Video upload limit: 500MB');
    console.log('=================================');
  });
});

module.exports = app;
