// PROJECT STRUCTURE
/*
fact-app/
├── backend/
│   ├── server.js              # Main entry point for backend
│   ├── factFetcher.js         # Automatic fact fetching system
│   ├── models/
│   │   └── Fact.js            # Database model for facts
│   ├── routes/
│   │   └── factRoutes.js      # API routes for facts
│   └── utils/
│       ├── parsers.js         # Source-specific content parsers
│       ├── categoryDetector.js # Categorization logic
│       └── engagementScore.js  # Algorithm for ranking facts
├── frontend/
│   ├── src/
│   │   ├── App.js             # Main React application
│   │   ├── components/
│   │   │   ├── FactCard.js    # Individual fact display
│   │   │   ├── FactList.js    # Container for facts
│   │   │   ├── Header.js      # App header with tabs
│   │   │   └── Welcome.js     # Welcome modal
│   │   ├── services/
│   │   │   └── factService.js # API communication
│   │   └── styles/
│   │       └── index.css      # Global styles
│   └── public/
│       └── index.html         # HTML entry point
└── package.json               # Project dependencies
*/

////////////////////////////////////////////
// BACKEND CODE
////////////////////////////////////////////

// backend/server.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const factRoutes = require('./routes/factRoutes');
const factFetcher = require('./factFetcher');

// Initialize express app
const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/factapp', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  useFindAndModify: false,
  useCreateIndex: true
})
.then(() => console.log('Connected to MongoDB'))
.catch(err => console.error('MongoDB connection error:', err));

// API routes
app.use('/api/facts', factRoutes);

// Serve static assets in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../frontend/build')));
  
  app.get('*', (req, res) => {
    res.sendFile(path.resolve(__dirname, '../frontend/build', 'index.html'));
  });
}

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  
  // Start fact fetcher on server startup
  factFetcher.initialize();
});

///////////////////////////////////////

// backend/factFetcher.js
const cron = require('node-cron');
const axios = require('axios');
const cheerio = require('cheerio');
const { v4: uuidv4 } = require('uuid');
const Fact = require('./models/Fact');
const parsers = require('./utils/parsers');
const { determineCategory } = require('./utils/categoryDetector');
const { calculateEngagementScore } = require('./utils/engagementScore');

// Configuration for fact sources
const factSources = [
  {
    name: 'Reddit TIL',
    type: 'api',
    category: 'mixed',
    url: 'https://www.reddit.com/r/todayilearned/top.json?limit=10&t=day',
    parser: parsers.redditTILParser
  },
  {
    name: 'NASA Astronomy Picture of the Day',
    type: 'api',
    category: 'space',
    url: 'https://api.nasa.gov/planetary/apod?api_key=' + (process.env.NASA_API_KEY || 'DEMO_KEY'),
    parser: parsers.nasaAPODParser
  },
  {
    name: 'National Geographic',
    type: 'rss',
    category: 'nature',
    url: 'https://www.nationalgeographic.com/animals/article/feed/index.rss',
    parser: parsers.natGeoParser
  },
  {
    name: 'Science Daily',
    type: 'scrape',
    category: 'science',
    url: 'https://www.sciencedaily.com/releases/',
    parser: parsers.scienceDailyParser
  },
  {
    name: 'History Facts API',
    type: 'api',
    category: 'history',
    url: 'https://history.muffinlabs.com/date',
    parser: parsers.historyFactsParser
  },
  {
    name: 'Random Knowledge API',
    type: 'api',
    category: 'mixed',
    url: 'https://api.aakhilv.me/fun/facts',
    parser: parsers.randomFactsParser
  }
];

// Main fetch function
async function fetchFactsFromSource(source) {
  try {
    console.log(`Fetching facts from ${source.name}...`);
    
    let response;
    if (source.type === 'api' || source.type === 'rss') {
      response = await axios.get(source.url);
      return await source.parser(response.data);
    } else if (source.type === 'scrape') {
      response = await axios.get(source.url);
      return await source.parser(response.data);
    }
    return [];
  } catch (error) {
    console.error(`Error fetching from ${source.name}:`, error.message);
    return [];
  }
}

// Process and store facts
async function processAndStoreFacts(facts) {
  const newFactsCount = {
    total: 0,
    byCategory: {}
  };
  
  for (const fact of facts) {
    try {
      // Check if similar fact already exists (avoid duplicates)
      const existingFactsCount = await Fact.countDocuments({
        $text: { $search: fact.text.substring(0, 50) }
      });
      
      if (existingFactsCount === 0) {
        // Add additional preprocessing or validation here
        if (fact.text.length > 20 && fact.text.length < 500) {
          await Fact.create(fact);
          
          // Update stats
          newFactsCount.total++;
          if (!newFactsCount.byCategory[fact.category]) {
            newFactsCount.byCategory[fact.category] = 0;
          }
          newFactsCount.byCategory[fact.category]++;
          
          console.log(`New fact added: ${fact.id} [${fact.category}]`);
        }
      }
    } catch (error) {
      console.error(`Error processing fact:`, error.message);
    }
  }
  
  return newFactsCount;
}

// Main function to run on schedule
async function fetchAllFacts() {
  console.log('Starting scheduled fact fetch...');
  let totalStats = { total: 0, byCategory: {} };
  
  for (const source of factSources) {
    const facts = await fetchFactsFromSource(source);
    const stats = await processAndStoreFacts(facts);
    
    // Combine stats
    totalStats.total += stats.total;
    for (const category in stats.byCategory) {
      if (!totalStats.byCategory[category]) {
        totalStats.byCategory[category] = 0;
      }
      totalStats.byCategory[category] += stats.byCategory[category];
    }
  }
  
  console.log('Fact fetch completed. Stats:', totalStats);
  return totalStats;
}

// Initialize and schedule fact fetching
function initialize() {
  // Schedule fact fetching (every 3 hours)
  cron.schedule('0 */3 * * *', fetchAllFacts);
  
  // Also run immediately on startup
  fetchAllFacts();
  
  console.log('Fact fetcher initialized');
}

module.exports = {
  initialize,
  fetchAllFacts // Exported for manual triggering
};

///////////////////////////////////////

// backend/models/Fact.js
const mongoose = require('mongoose');

const factSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true
  },
  text: {
    type: String,
    required: true
  },
  category: {
    type: String,
    required: true,
    enum: ['science', 'history', 'tech', 'space', 'psychology', 'nature', 'art', 'food', 'mixed']
  },
  source: {
    type: String,
    required: true
  },
  sourceUrl: {
    type: String
  },
  imageUrl: {
    type: String
  },
  engagement: {
    type: Number,
    required: true,
    min: 1,
    max: 100
  },
  dateAdded: {
    type: Date,
    default: Date.now
  },
  isVerified: {
    type: Boolean,
    default: false
  }
});

// Add text index for searching
factSchema.index({ text: 'text' });

const Fact = mongoose.model('Fact', factSchema);

module.exports = Fact;

///////////////////////////////////////

// backend/routes/factRoutes.js
const express = require('express');
const router = express.Router();
const Fact = require('../models/Fact');
const { ObjectId } = require('mongoose').Types;

// Get trending facts
router.get('/trending', async (req, res) => {
  try {
    const { limit = 10, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Get facts within the last week, sorted by engagement
    const facts = await Fact.find({
      dateAdded: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
    })
    .sort({ engagement: -1 })
    .skip(skip)
    .limit(parseInt(limit));
    
    res.json(facts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get latest facts
router.get('/latest', async (req, res) => {
  try {
    const { limit = 10, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const facts = await Fact.find()
      .sort({ dateAdded: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    res.json(facts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get facts by category
router.get('/category/:category', async (req, res) => {
  try {
    const { category } = req.params;
    const { limit = 10, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const facts = await Fact.find({ category })
      .sort({ dateAdded: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    res.json(facts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get facts by IDs (for saved facts)
router.post('/byIds', async (req, res) => {
  try {
    const { ids } = req.body;
    
    if (!ids || !Array.isArray(ids)) {
      return res.status(400).json({ message: 'Invalid request. Expected array of IDs.' });
    }
    
    const facts = await Fact.find({ id: { $in: ids } });
    res.json(facts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Default route for all facts with various filters
router.get('/', async (req, res) => {
  try {
    const { 
      category, 
      limit = 10, 
      page = 1,
      sort = 'dateAdded',
      order = 'desc'
    } = req.query;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sortOrder = order === 'desc' ? -1 : 1;
    const sortOptions = {};
    sortOptions[sort] = sortOrder;
    
    // Build query
    const query = {};
    if (category && category !== 'all') {
      query.category = category;
    }
    
    const facts = await Fact.find(query)
      .sort(sortOptions)
      .skip(skip)
      .limit(parseInt(limit));
    
    res.json(facts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;

///////////////////////////////////////

// backend/utils/parsers.js
const cheerio = require('cheerio');
const { v4: uuidv4 } = require('uuid');
const { determineCategory } = require('./categoryDetector');
const { calculateEngagementScore } = require('./engagementScore');

// Reddit TIL parser
async function redditTILParser(data) {
  const facts = [];
  const posts = data.data.children;
  
  for (const post of posts) {
    if (post.data.score > 1000) { // Only high-quality posts
      const title = post.data.title.replace('TIL ', '').replace('TIL that ', '');
      
      facts.push({
        id: uuidv4(),
        text: title,
        category: determineCategory(title),
        source: 'Reddit r/TodayILearned',
        sourceUrl: `https://reddit.com${post.data.permalink}`,
        engagement: calculateEngagementScore(post.data.score, post.data.num_comments),
        dateAdded: new Date(),
        isVerified: false
      });
    }
  }
  
  return facts;
}

// NASA APOD parser
async function nasaAPODParser(data) {
  const explanation = data.explanation || '';
  // Get first 2-3 sentences for brevity
  const sentences = explanation.split('.');
  const shortExplanation = sentences.slice(0, Math.min(3, sentences.length)).join('.') + '.';
  
  return [{
    id: uuidv4(),
    text: shortExplanation,
    category: 'space',
    source: 'NASA Astronomy Picture of the Day',
    sourceUrl: 'https://apod.nasa.gov/apod/',
    imageUrl: data.url,
    engagement: 95, // NASA content is typically highly engaging
    dateAdded: new Date(),
    isVerified: true
  }];
}

// Science Daily parser
async function scienceDailyParser(html) {
  const $ = cheerio.load(html);
  const facts = [];
  
  $('.latest-head').each((i, element) => {
    const title = $(element).text().trim();
    const link = $(element).find('a').attr('href');
    
    facts.push({
      id: uuidv4(),
      text: title,
      category: 'science',
      source: 'Science Daily',
      sourceUrl: `https://www.sciencedaily.com${link}`,
      engagement: 90,
      dateAdded: new Date(),
      isVerified: true
    });
  });
  
  return facts.slice(0, 5); // Take only top 5 facts
}

// History Facts parser
async function historyFactsParser(data) {
  const facts = [];
  
  if (data && data.data && data.data.Events) {
    for (const event of data.data.Events.slice(0, 5)) {
      facts.push({
        id: uuidv4(),
        text: `On this day in ${event.year}: ${event.text}`,
        category: 'history',
        source: 'History Facts API',
        sourceUrl: '',
        engagement: 85 + Math.floor(Math.random() * 10), // Some randomization
        dateAdded: new Date(),
        isVerified: true
      });
    }
  }
  
  return facts;
}

// Random Facts parser
async function randomFactsParser(data) {
  if (!Array.isArray(data)) {
    return [];
  }
  
  return data.map(factText => ({
    id: uuidv4(),
    text: factText,
    category: determineCategory(factText),
    source: 'Random Knowledge API',
    sourceUrl: '',
    engagement: 80 + Math.floor(Math.random() * 15),
    dateAdded: new Date(),
    isVerified: true
  }));
}

// NatGeo parser (simplified for example)
async function natGeoParser(data) {
  const facts = [];
  // In a real implementation, you would parse the RSS feed
  // This is a simplified example
  
  // Simulated results
  facts.push({
    id: uuidv4(),
    text: "Dolphins recognize themselves in mirrors, displaying self-awareness typically seen only in humans and great apes.",
    category: 'nature',
    source: 'National Geographic',
    sourceUrl: 'https://www.nationalgeographic.com/',
    engagement: 94,
    dateAdded: new Date(),
    isVerified: true
  });
  
  return facts;
}

module.exports = {
  redditTILParser,
  nasaAPODParser,
  scienceDailyParser,
  historyFactsParser,
  randomFactsParser,
  natGeoParser
};

///////////////////////////////////////

// backend/utils/categoryDetector.js
function determineCategory(text) {
  const categoryKeywords = {
    science: ['scientist', 'discovered', 'study', 'research', 'laboratory', 'experiment', 'physics', 'chemistry', 'biology'],
    history: ['ancient', 'century', 'year', 'historical', 'war', 'king', 'queen', 'empire', 'civilization'],
    tech: ['computer', 'technology', 'software', 'hardware', 'digital', 'internet', 'app', 'device', 'code'],
    space: ['planet', 'star', 'galaxy', 'astronaut', 'nasa', 'space', 'orbit', 'moon', 'asteroid', 'cosmic'],
    psychology: ['brain', 'behavior', 'mental', 'psychology', 'cognitive', 'emotion', 'memory', 'mind'],
    nature: ['animal', 'plant', 'species', 'wildlife', 'ocean', 'forest', 'ecosystem', 'environment'],
    art: ['museum', 'painting', 'artist', 'music', 'culture', 'literature', 'book', 'movie', 'film'],
    food: ['food', 'recipe', 'cuisine', 'ingredient', 'dish', 'taste', 'flavor', 'restaurant', 'chef']
  };
  
  const lowercaseText = text.toLowerCase();
  
  // Check each category
  const categoryScores = {};
  
  for (const [category, keywords] of Object.entries(categoryKeywords)) {
    categoryScores[category] = 0;
    
    for (const keyword of keywords) {
      if (lowercaseText.includes(keyword)) {
        categoryScores[category] += 1;
      }
    }
  }
  
  // Find the highest scoring category
  let highestCategory = 'mixed';
  let highestScore = 0;
  
  for (const [category, score] of Object.entries(categoryScores)) {
    if (score > highestScore) {
      highestScore = score;
      highestCategory = category;
    }
  }
  
  // If the score is too low, default to mixed
  return highestScore > 0 ? highestCategory : 'mixed';
}

module.exports = {
  determineCategory
};

///////////////////////////////////////

// backend/utils/engagementScore.js
function calculateEngagementScore(upvotes, comments) {
  // Base engagement score calculation
  if (upvotes && comments) {
    // Reddit-style content
    let score = Math.min(99, Math.floor(85 + (upvotes / 10000) * 15));
    
    if (comments > 500) score += 2;
    if (upvotes > 10000) score += 3;
    
    return score;
  }
  
  // For other sources, return a baseline score
  return 85 + Math.floor(Math.random() * 10);
}

module.exports = {
  calculateEngagementScore
};

////////////////////////////////////////////
// FRONTEND CODE
////////////////////////////////////////////

// frontend/src/App.js
import React, { useState, useEffect } from 'react';
import Header from './components/Header';
import FactList from './components/FactList';
import Welcome from './components/Welcome';
import { fetchTrendingFacts, fetchLatestFacts, fetchFactsByIds } from './services/factService';
import './styles/index.css';

function App() {
  const [facts, setFacts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [theme, setTheme] = useState('dark');
  const [savedFacts, setSavedFacts] = useState([]);
  const [currentTab, setCurrentTab] = useState('trending');
  const [showNewBadge, setShowNewBadge] = useState(true);
  const [showWelcome, setShowWelcome] = useState(true);
  
  // Load saved facts from localStorage on initial load
  useEffect(() => {
    const savedFactIds = JSON.parse(localStorage.getItem('savedFacts') || '[]');
    setSavedFacts(savedFactIds);
    
    // Check system preference for dark mode
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      setTheme('dark');
    }
    
    // Listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e) => setTheme(e.matches ? 'dark' : 'light');
    mediaQuery.addEventListener('change', handleChange);
    
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);
  
  // Fetch facts based on current tab
  useEffect(() => {
    setLoading(true);
    setFacts([]);
    setPage(1);
    
    const fetchData = async () => {
      let data = [];
      
      if (currentTab === 'trending') {
        data = await fetchTrendingFacts(1);
      } else if (currentTab === 'latest') {
        data = await fetchLatestFacts(1);
        setShowNewBadge(false);
      } else if (currentTab === 'saved') {
        if (savedFacts.length > 0) {
          data = await fetchFactsByIds(savedFacts);
        }
      }
      
      setFacts(data);
      setLoading(false);
    };
    
    fetchData();
  }, [currentTab, savedFacts]);
  
  // Load more facts on scroll
  const loadMoreFacts = async () => {
    if (currentTab === 'saved' || loading) return;
    
    setLoading(true);
    const nextPage = page + 1;
    
    let newFacts = [];
    if (currentTab === 'trending') {
      newFacts = await fetchTrendingFacts(nextPage);
    } else if (currentTab === 'latest') {
      newFacts = await fetchLatestFacts(nextPage);
    }
    
    if (newFacts.length > 0) {
      setFacts(prev => [...prev, ...newFacts]);
      setPage(nextPage);
    }
    
    setLoading(false);
  };
  
  // Toggle theme
  const toggleTheme = () => {
    setTheme(theme === 'light' ? 'dark' : 'light');
  };
  
  // Toggle save fact
  const toggleSaveFact = (id) => {
    if (savedFacts.includes(id)) {
      const updatedSavedFacts = savedFacts.filter(factId => factId !== id);
      setSavedFacts(updatedSavedFacts);
      localStorage.setItem('savedFacts', JSON.stringify(updatedSavedFacts));
    } else {
      const updatedSavedFacts = [...savedFacts, id];
      setSavedFacts(updatedSavedFacts);
      localStorage.setItem('savedFacts', JSON.stringify(updatedSavedFacts));
    }
  };
  
  // Close welcome modal
  const closeWelcome = () => {
    setShowWelcome(false);
    localStorage.setItem('welcomeShown', 'true');
  };

  return (
    <div className={`min-h-screen transition-colors duration-300 ${theme === 'dark' ? 'bg-gray-900 text-gray-100' : 'bg-gray-50 text-gray-800'}`}>
      <Header 
        theme={theme}
        toggleTheme={toggleTheme}
        currentTab={currentTab}
        setCurrentTab={setCurrentTab}
        showNewBadge={showNewBadge}
        savedFactsCount={savedFacts.length}
      />
      
      <FactList 
        facts={facts}
        loading={loading}
        loadMoreFacts={loadMoreFacts}
        savedFacts={savedFacts}
        toggleSaveFact={toggleSaveFact}
        currentTab={currentTab}
        theme={theme}
        setCurrentTab={setCurrentTab}
      />
      
      {showWelcome && <Welcome theme={theme} closeWelcome={closeWelcome} />}
    </div>
  );
}

export default App;

///////////////////////////////////////

// frontend/src/components/Header.js
import React, { useState, useEffect } from 'react';

function Header({ theme, toggleTheme, currentTab, setCurrentTab, showNewBadge, savedFactsCount }) {
  const [timeSpent, setTimeSpent] = useState(0);
  
  // Current date for "daily facts" feature
  const today = new Date();
  const dateString = today.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  
  // Time tracking
  useEffect(() => {
    const timer = setInterval(() => {
      setTimeSpent(prev => prev + 1);
    }, 1000);
    
    return () => clearInterval(timer);
  }, []);
  
  // Format time as mm:ss
  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <header className={`sticky top-0 z-20 ${theme === 'dark' ? 'bg-gray-900/90 border-gray-800' : 'bg-white/90 border-gray-200'} border-b backdrop-blur-lg shadow-sm transition-all duration-300`}>
      <div className="max-w-2xl mx-auto px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className="bg-gradient-to-br from-indigo-500 to-purple-600 text-white w-10 h-10 rounded-xl flex items-center justify-center text-xl font-bold shadow-lg">
              F
            </div>
            <div>
              <h1 className="text-xl font-bold">FactVault</h1>
              <p className={`text-xs ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>{dateString}</p>
            </div>
          </div>
          
          <div className="flex items-center space-x-3">
            <button
              onClick={toggleTheme}
              className={`p-2 rounded-full ${theme === 'dark' ? 'bg-gray-800 text-yellow-300' : 'bg-gray-200 text-gray-700'}`}
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
            
            <div className={`py-1.5 px-3 rounded-full text-xs font-medium ${theme === 'dark' ? 'bg-gray-800' : 'bg-gray-200'}`}>
              {formatTime(timeSpent)}
            </div>
          </div>
        </div>
        
        {/* Tab navigation */}
        <div className="flex mt-4 border-b border-gray-200 dark:border-gray-700">
          <button 
            onClick={() => setCurrentTab('trending')}
            className={`flex items-center px-3 py-2 text-sm font-medium border-b-2 ${currentTab === 'trending' ? (theme === 'dark' ? 'border-purple-500 text-purple-400' : 'border-purple-500 text-purple-600') : 'border-transparent'}`}
          >
            <span className="mr-1">🔥</span>
            Most Interesting
          </button>
          
          <button 
            onClick={() => setCurrentTab('latest')}
            className={`flex items-center px-3 py-2 text-sm font-medium border-b-2 ${currentTab === 'latest' ? (theme === 'dark' ? 'border-green-500 text-green-400' : 'border-green-500 text-green-600') : 'border-transparent'} relative`}
          >
            <span className="mr-1">✨</span>
            Today's Facts
            {showNewBadge && (
              <span className={`absolute -top-1 -right-1 px-1.5 py-0.5 text-xs font-bold rounded-full bg-red-500 text-white`}>
                NEW
              </span>
            )}
          </button>
          
          <button 
            onClick={() => setCurrentTab('saved')}
            className={`flex items-center px-3 py-2 text-sm font-medium border-b-2 ${currentTab === 'saved' ? (theme === 'dark' ? 'border-yellow-500 text-yellow-400' : 'border-yellow-500 text-yellow-600') : 'border-transparent'}`}
          >
            <span className="mr-1">🔖</span>
            Saved
            {savedFactsCount > 0 && (
              <span className={`ml-1 w-5 h-5 flex items-center justify-center text-xs rounded-full ${theme === 'dark' ? 'bg-gray-800' : 'bg-gray-200'}`}>
                {savedFactsCount}
              </span>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}

export default Header;

///////////////////////////////////////

// frontend/src/components/FactCard.js
import React from 'react';

function FactCard({ fact, isSaved, toggleSaveFact, theme }) {
  // Category information
  const categories = [
    { id: 'science', name: 'Science', icon: '🔬' },
    { id: 'history', name: 'History', icon: '📜' },
    { id: 'tech', name: 'Technology', icon: '💻' },
    { id: 'space', name: 'Space', icon: '🚀' },
    { id: 'psychology', name: 'Psychology', icon: '🧠' },
    { id: 'nature', name: 'Nature', icon: '🌿' },
    { id: 'art', name: 'Art & Culture', icon: '🎨' },
    { id: 'food', name: 'Food', icon: '🍽️' },
    { id: 'mixed', name: 'General', icon: '📌' }
  ];
  
  // Category colors
  const categoryColors = {
    science: {
      light: { bg: 'bg-blue-100', text: 'text-blue-800', icon: 'bg-blue-200' },
      dark: { bg: 'bg-blue-900', text: 'text-blue-100', icon: 'bg-blue-800' }
    },
    history: {
      light: { bg: 'bg-amber-100', text: 'text-amber-800', icon: 'bg-amber-200' },
      dark: { bg: 'bg-amber-900', text: 'text-amber-100', icon: 'bg-amber-800' }
    },
    tech: {
      light: { bg: 'bg-purple-100', text: 'text-purple-800', icon: 'bg-purple-200' },
      dark: { bg: 'bg-purple-900', text: 'text-purple-100', icon: 'bg-purple-800' }
    },
    space: {
      light: { bg: 'bg-indigo-100', text: 'text-indigo-800', icon: 'bg-indigo-200' },
      dark: { bg: 'bg-indigo-900', text: 'text-indigo-100', icon: 'bg-indigo-800' }
    },
    psychology: {
      light: { bg: 'bg-pink-100', text: 'text-pink-800', icon: 'bg-pink-200' },
      dark: { bg: 'bg-pink-900', text: 'text-pink-100', icon: 'bg-pink-800' }
    },
    nature: {
      light: { bg: 'bg-green-100', text: 'text-green-800', icon: 'bg-green-200' },
      dark: { bg: 'bg-green-900', text: 'text-green-100', icon: 'bg-green-800' }
    },
    art: {
      light: { bg: 'bg-rose-100', text: 'text-rose-800', icon: 'bg-rose-200' },
      dark: { bg: 'bg-rose-900', text: 'text-rose-100', icon: 'bg-rose-800' }
    },
    food: {
      light: { bg: 'bg-orange-100', text: 'text-orange-800', icon: 'bg-orange-200' },
      dark: { bg: 'bg-orange-900', text: 'text-orange-100', icon: 'bg-orange-800' }
    },
    mixed: {
      light: { bg: 'bg-gray-100', text: 'text-gray-800', icon: 'bg-gray-200' },
      dark: { bg: 'bg-gray-800', text: 'text-gray-100', icon: 'bg-gray-700' }
    }
  };
  
  // Check if fact is new (added within the last 24 hours)
  const isNew = new Date(fact.dateAdded) > new Date(Date.now() - 24 * 60 * 60 * 1000);
  
  // Get category info
  const categoryInfo = categories.find(cat => cat.id === fact.category) || categories[8]; // Default to 'mixed'
  const categoryColor = categoryColors[fact.category] || categoryColors.mixed;
  const currentColors = categoryColor[theme === 'dark' ? 'dark' : 'light'];

  return (
    <div 
      className={`rounded-xl overflow-hidden transition-all duration-300 transform hover:-translate-y-1 ${theme === 'dark' ? 'bg-gray-800 shadow-lg' : 'bg-white shadow-md'} relative`}
    >
      <div className="p-5">
        <div className="flex justify-between items-start mb-4">
          {/* Category badge */}
          <div className={`flex items-center ${currentColors.bg} ${currentColors.text} px-3 py-1 rounded-full text-sm`}>
            <span className="mr-1">{categoryInfo.icon}</span>
            <span>{categoryInfo.name}</span>
          </div>
          
          {/* Save button */}
          <button 
            onClick={() => toggleSaveFact(fact.id)}
            className={`p-2 rounded-full transition-colors ${isSaved ? 'text-yellow-500' : theme === 'dark' ? 'text-gray-400 hover:text-gray-300' : 'text-gray-400 hover:text-gray-700'}`}
            aria-label={isSaved ? "Unsave fact" : "Save fact"}
          >
            {isSaved ? '★' : '☆'}
          </button>
        </div>
        
        {/* Fact content */}
        <p className="text-lg mb-4 leading-relaxed">{fact.text}</p>
        
        {/* Image if available */}
        {fact.imageUrl && (
          <div className="mt-3 mb-4 rounded-lg overflow-hidden">
            <img 
              src={fact.imageUrl} 
              alt={fact.text.substring(0, 30) + '...'}
              className="w-full h-auto object-cover" 
            />
          </div>
        )}
        
        {/* Fact metadata */}
        <div className="flex justify-between items-center mt-4 pt-3 border-t border-gray-200 dark:border-gray-700">
          <div className={`text-xs ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
            Source: {fact.source}
          </div>
          
          {/* Interest rating */}
          <div className="flex items-center">
            <div className={`text-xs font-medium mr-1 ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>
              Engagement:
            </div>
            <div className={`text-sm font-bold ${fact.engagement >= 95 ? 'text-green-500' : fact.engagement >= 90 ? 'text-yellow-500' : 'text-gray-500'}`}>
              {fact.engagement}%
            </div>
          </div>
        </div>
        
        {/* New badge */}
        {isNew && (
          <div className="absolute top-0 right-0 bg-gradient-to-r from-red-500 to-pink-500 text-white text-xs font-bold py-1 px-3 rounded-bl-lg">
            NEW TODAY
          </div>
        )}
      </div>
      
      {/* Read more link if sourceUrl is available */}
      {fact.sourceUrl && (
        <a 
          href={fact.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={`block py-2 px-5 text-center text-sm font-medium ${theme === 'dark' ? 'bg-gray-700 hover:bg-gray-600 text-gray-200' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'}`}
        >
          Read more
        </a>
      )}
    </div>
  );
}

export default FactCard;

///////////////////////////////////////

// frontend/src/components/FactList.js
import React, { useRef, useEffect } from 'react';
import FactCard from './FactCard';

function FactList({ 
  facts, 
  loading, 
  loadMoreFacts, 
  savedFacts, 
  toggleSaveFact, 
  currentTab, 
  theme,
  setCurrentTab
}) {
  const loader = useRef(null);
  
  // Set up intersection observer for infinite scrolling
  useEffect(() => {
    const options = {
      root: null,
      rootMargin: "100px",
      threshold: 0.1
    };
    
    // Observer callback
    const handleObserver = (entities) => {
      const target = entities[0];
      if (target.isIntersecting && !loading && currentTab !== 'saved') {
        loadMoreFacts();
      }
    };
    
    // Create observer
    const observer = new IntersectionObserver(handleObserver, options);
    if (loader.current) {
      observer.observe(loader.current);
    }
    
    return () => {
      if (loader.current) {
        observer.unobserve(loader.current);
      }
    };
  }, [loading, loadMoreFacts, currentTab]);
  
  // Calculate reading time in minutes
  const calculateReadingTime = () => {
    const wordsPerMinute = 200;
    let totalWords = 0;
    
    facts.forEach(fact => {
      totalWords += fact.text.split(' ').length;
    });
    
    return Math.max(1, Math.round(totalWords / wordsPerMinute));
  };

  return (
    <>
      {/* Content - Facts card layout */}
      <main className="max-w-2xl mx-auto px-4 py-6 pb-20">
        {/* Empty state for saved tab */}
        {currentTab === 'saved' && facts.length === 0 && (
          <div className={`text-center py-12 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
            <div className="text-5xl mb-4">🔖</div>
            <h3 className="text-xl font-medium mb-2">No saved facts yet</h3>
            <p className="mb-6">Tap the bookmark icon on any fact to save it for later</p>
            <button 
              onClick={() => setCurrentTab('trending')}
              className={`px-4 py-2 rounded-lg font-medium ${theme === 'dark' ? 'bg-gray-800' : 'bg-gray-200'}`}
            >
              Discover facts
            </button>
          </div>
        )}
        
        {/* Facts cards */}
        <div className="space-y-5">
          {facts.map((fact) => (
            <div 
              key={fact.id} 
              style={{ 
                opacity: 0,
                animation: `fadeInUp 0.5s ease-out ${Math.random() * 0.3}s forwards`
              }}
            >
              <FactCard 
                fact={fact}
                isSaved={savedFacts.includes(fact.id)}
                toggleSaveFact={toggleSaveFact}
                theme={theme}
              />
            </div>
          ))}
          
          {/* Loading indicator */}
          <div ref={loader} className="py-8 flex justify-center">
            {loading && (
              <div className="flex flex-col items-center">
                <div className="relative w-12 h-12">
                  <div className={`absolute top-0 w-full h-full border-4 rounded-full ${theme === 'dark' ? 'border-gray-700' : 'border-gray-200'}`}></div>
                  <div className="absolute top-0 w-full h-full border-4 border-t-indigo-500 border-r-transparent border-b-transparent border-l-transparent rounded-full animate-spin"></div>
                </div>
                <p className={`mt-3 text-sm ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                  Loading more facts...
                </p>
              </div>
            )}
          </div>
          
          {/* End of content indicator */}
          {currentTab === 'saved' && facts.length > 0 && (
            <div className={`text-center py-6 ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`}>
              <div className="inline-block w-16 h-1 bg-gray-300 dark:bg-gray-700 rounded-full"></div>
              <p className="mt-4 text-sm">End of saved facts</p>
            </div>
          )}
        </div>
      </main>
      
      {/* Footer with stats */}
      <div className={`fixed bottom-0 left-0 right-0 border-t transition-colors duration-300 ${theme === 'dark' ? 'bg-gray-900 border-gray-800' : 'bg-white border-gray-200'} shadow-lg z-10`}>
        <div className="max-w-2xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <div className={`text-sm ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                <span className="font-medium">{facts.length}</span> facts
              </div>
              
              <div className={`text-sm ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>
                <span className="font-medium">{calculateReadingTime()}</span> min read
              </div>
            </div>
            
            <div className="flex items-center space-x-3">
              {currentTab !== 'latest' && (
                <button 
                  onClick={() => setCurrentTab('latest')}
                  className={`py-2 px-4 text-sm font-medium rounded-lg ${theme === 'dark' ? 'bg-gray-800 text-green-400' : 'bg-green-100 text-green-800'} flex items-center`}
                >
                  <span className="mr-1.5">✨</span>
                  See Today's Facts
                </button>
              )}
              
              {currentTab === 'latest' && (
                <button 
                  onClick={() => setCurrentTab('trending')}
                  className={`py-2 px-4 text-sm font-medium rounded-lg ${theme === 'dark' ? 'bg-gray-800 text-purple-400' : 'bg-purple-100 text-purple-800'} flex items-center`}
                >
                  <span className="mr-1.5">🔥</span>
                  Most Interesting
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export default FactList;

///////////////////////////////////////

// frontend/src/components/Welcome.js
import React from 'react';

function Welcome({ theme, closeWelcome }) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className={`max-w-md w-full rounded-xl p-6 shadow-2xl ${theme === 'dark' ? 'bg-gray-800' : 'bg-white'}`}>
        <div className="text-center mb-4">
          <div className="bg-gradient-to-br from-indigo-500 to-purple-600 text-white w-16 h-16 rounded-xl flex items-center justify-center text-3xl font-bold shadow-lg mx-auto mb-4">
            F
          </div>
          <h2 className="text-2xl font-bold mb-2">Welcome to FactVault</h2>
          <p className={`mb-6 ${theme === 'dark' ? 'text-gray-300' : 'text-gray-600'}`}>
            Your daily dose of the world's most fascinating facts
          </p>
        </div>
        
        <div className="space-y-4 mb-6">
          <div className={`flex items-center p-3 rounded-lg ${theme === 'dark' ? 'bg-gray-700' : 'bg-gray-100'}`}>
            <div className="text-xl mr-3">🔥</div>
            <div>
              <h3 className="font-medium">Most Interesting</h3>
              <p className="text-sm opacity-70">Facts ranked by how fascinating they are</p>
            </div>
          </div>
          
          <div className={`flex items-center p-3 rounded-lg ${theme === 'dark' ? 'bg-gray-700' : 'bg-gray-100'}`}>
            <div className="text-xl mr-3">✨</div>
            <div>
              <h3 className="font-medium">Daily Updates</h3>
              <p className="text-sm opacity-70">New facts published every day</p>
            </div>
          </div>
          
          <div className={`flex items-center p-3 rounded-lg ${theme === 'dark' ? 'bg-gray-700' : 'bg-gray-100'}`}>
            <div className="text-xl mr-3">🔖</div>
            <div>
              <h3 className="font-medium">Save Favorites</h3>
              <p className="text-sm opacity-70">Bookmark facts you want to remember</p>
            </div>
          </div>
        </div>
        
        <button 
          onClick={closeWelcome}
          className="w-full py-3 rounded-lg font-medium bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-lg"
        >
          Start Exploring
        </button>
      </div>
    </div>
  );
}

export default Welcome;

///////////////////////////////////////

// frontend/src/services/factService.js
// API functions to communicate with backend

export async function fetchTrendingFacts(page = 1) {
  try {
    const response = await fetch(`/api/facts/trending?page=${page}&limit=10`);
    
    if (!response.ok) {
      throw new Error('Network response was not ok');
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error fetching trending facts:', error);
    return [];
  }
}

export async function fetchLatestFacts(page = 1) {
  try {
    const response = await fetch(`/api/facts/latest?page=${page}&limit=10`);
    
    if (!response.ok) {
      throw new Error('Network response was not ok');
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error fetching latest facts:', error);
    return [];
  }
}

export async function fetchFactsByCategory(category, page = 1) {
  try {
    const response = await fetch(`/api/facts/category/${category}?page=${page}&limit=10`);
    
    if (!response.ok) {
      throw new Error('Network response was not ok');
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error(`Error fetching ${category} facts:`, error);
    return [];
  }
}

export async function fetchFactsByIds(ids) {
  try {
    const response = await fetch(`/api/facts/byIds`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ids }),
    });
    
    if (!response.ok) {
      throw new Error('Network response was not ok');
    }
    
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error fetching facts by IDs:', error);
    return [];
  }
}

///////////////////////////////////////

// frontend/src/styles/index.css
/* This would be the global styles for your app, including Tailwind directives */
@tailwind base;
@tailwind components;
@tailwind utilities;

/* Animation keyframes */
@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Custom scrollbar styles */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  @apply bg-gray-100 dark:bg-gray-800;
}

::-webkit-scrollbar-thumb {
  @apply bg-gray-300 dark:bg-gray-600 rounded-full;
}

::-webkit-scrollbar-thumb:hover {
  @apply bg-gray-400 dark:bg-gray-500;
}

/* Global focus styles */
:focus {
  @apply outline-none ring-2 ring-indigo-500 dark:ring-indigo-400;
}

/* Smooth transitions */
* {
  @apply transition-colors duration-200;
}

///////////////////////////////////////

// package.json
{
  "name": "factvault",
  "version": "1.0.0",
  "description": "A fact browsing application with automatic content fetching",
  "main": "backend/server.js",
  "scripts": {
    "start": "node backend/server.js",
    "server": "nodemon backend/server.js",
    "client": "npm start --prefix frontend",
    "dev": "concurrently \"npm run server\" \"npm run client\"",
    "build": "cd frontend && npm run build",
    "install-client": "cd frontend && npm install",
    "install-server": "npm install",
    "install-all": "npm run install-server && npm run install-client",
    "heroku-postbuild": "NPM_CONFIG_PRODUCTION=false npm run install-client && npm run build"
  },
  "dependencies": {
    "axios": "^0.24.0",
    "cheerio": "^1.0.0-rc.10",
    "cors": "^2.8.5",
    "express": "^4.17.2",
    "mongoose": "^6.1.5",
    "node-cron": "^3.0.0",
    "uuid": "^8.3.2"
  },
  "devDependencies": {
    "concurrently": "^7.0.0",
    "nodemon": "^2.0.15"
  },
  "engines": {
    "node": "16.x"
  }
}
