import * as dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const { GOOGLE_API_KEY, TMDB_API_KEY, TMDB_BEARER_TOKEN } = process.env;
const PORT = process.env.PORT || 8080;

if (!GOOGLE_API_KEY || !TMDB_API_KEY) {
  console.error('Error: GOOGLE_API_KEY and/or TMDB_API_KEY must be set in your .env file.');
  process.exit(1);
}

// --- Configuration & Clients ---
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
const app = express();

const tmdbHeaders = TMDB_BEARER_TOKEN
  ? {
      accept: 'application/json',
      Authorization: `Bearer ${TMDB_BEARER_TOKEN}`,
    }
  : undefined;

// Axios TMDB instance
const tmdbAxios = axios.create({
  baseURL: TMDB_BASE_URL,
  headers: tmdbHeaders,
});

// Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// --- Type Definitions (for documentation purposes) ---
// Movie interface structure:
// {
//   id: number;
//   title: string;
//   overview: string;
//   poster_url: string | null;
//   release_year: string;
//   rating: number;
// }

// MovieHistory interface structure:
// {
//   id?: number;
//   user_id: string;
//   movie_id: number;
//   movie_title: string;
//   movie_genre_ids: number[];
//   clicked_at?: string;
//   movie_rating: number;
// }

// --- Helper Functions ---

/**
 * Transforms raw TMDB API movie data into our simplified Movie object.
 * @param {Object} tmdbMovie - The movie object from the TMDB API.
 * @returns {Object} A simplified Movie object.
 */
const formatTmdbMovie = (tmdbMovie) => ({
  id: tmdbMovie.id,
  title: tmdbMovie.title,
  overview: tmdbMovie.overview,
  poster_url: tmdbMovie.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbMovie.poster_path}` : null,
  release_year: tmdbMovie.release_date ? tmdbMovie.release_date.split('-')[0] : 'N/A',
  rating: tmdbMovie.vote_average,
  genre_ids: tmdbMovie.genre_ids || [], // Include genre IDs for frontend
});

// --- API Logic ---

/**
 * Fetches the current top-rated movies directly from TMDB.
 * @returns {Promise<Array>} A promise that resolves to a list of top-rated movies.
 */
const getTopRatedMovies = async () => {
  const url = `/movie/top_rated?language=en-US&page=1`;
  const response = await tmdbAxios.get(url);
  if (!response.data || !response.data.results) {
    throw new Error('Failed to fetch top-rated movies from TMDB.');
  }
  return response.data.results.slice(0, 20).map(formatTmdbMovie);
};

/**
 * Fetches the current popular movies directly from TMDB.
 * @returns {Promise<Array>} A promise that resolves to a list of popular movies.
 */
const getPopularMovies = async () => {
  const url = '/movie/popular?language=en-US&page=1';
  const response = await tmdbAxios.get(url);
  if (!response.data || !response.data.results) {
    throw new Error('Failed to fetch popular movies from TMDB.');
  }
  return response.data.results.slice(0, 20).map(formatTmdbMovie);
};

/**
 * Gets mood-based movie recommendations by asking the LLM for a single genre,
 * then fetching the most popular movies from that genre on TMDB.
 * @param {string} mood The user's mood.
 * @returns {Promise<Array>} A promise that resolves to a list of recommended movies.
 */
const getMoodRecommendations = async (mood) => {
  // Step 1: Ask Gemini to translate the mood into one or more genres.
  const genreList = "Action, Adventure, Animation, Comedy, Crime, Documentary, Drama, Family, Fantasy, History, Horror, Music, Mystery, Romance, Science Fiction, TV Movie, Thriller, War, Western";
  const prompt = `
    A user wants to watch movies that fit a "${mood}" mood.
    From the following list of official TMDB movie genres, choose the 1-3 best genres that represent this mood:
    ${genreList}

    Return ONLY a comma-separated list of genre names, and nothing else.
    Your response should not contain any special formatting, quotes, or introductory text.

    Example for mood "I want to laugh out loud":
    Comedy

    Example for mood "feeling scared and on edge":
    Horror, Thriller

    Now, provide the best genres for the mood: "${mood}"
  `;

  const result = await model.generateContent(prompt);
  const genreNames = result.response.text().trim().split(',').map(g => g.trim().toLowerCase());
  console.log(`Gemini suggested genres for "${mood}":`, genreNames);

  // Step 2: Map genre names to TMDB genre IDs
  const genreIds = genreNames
    .map(name => TMDB_GENRE_MAP[name])
    .filter(Boolean)
    .join(',');

  if (!genreIds) {
    console.warn(`Could not find valid TMDB genres for "${genreNames}". Falling back to top-rated movies.`);
    return getTopRatedMovies();
  }
  console.log(`Found TMDB genre IDs: ${genreIds} for genres: "${genreNames.join(', ')}"`);

  // Step 3: Use TMDB Discover endpoint with multiple genres, sorted by rating, limited to 10
  const discoverUrl = `/discover/movie?language=en-US&sort_by=vote_average.desc&vote_count.gte=100&include_adult=false&with_genres=${genreIds}&page=1`;
  const discoverResponse = await tmdbAxios.get(discoverUrl);

  if (!discoverResponse.data || !discoverResponse.data.results || discoverResponse.data.results.length === 0) {
    console.warn(`Discovery for genres "${genreNames.join(', ')}" returned no results. Falling back to top-rated movies.`);
    return getTopRatedMovies();
  }

  // Step 4: Return the top 20 movies from the discovery results.
  return discoverResponse.data.results.slice(0, 20).map(formatTmdbMovie);
};

/**
 * Gets personalized recommendations based on user's movie history
 * @param {string} userId The user's ID
 * @returns {Promise<Array>} A promise that resolves to a list of recommended movies
 */
const getPersonalizedRecommendations = async (userId) => {
  try {
    // Fetch last 20 movies from user's history
    const { data: history, error } = await supabase
      .from('movie_history')
      .select('*')
      .eq('user_id', userId)
      .order('clicked_at', { ascending: false })
      .limit(20);

    if (error) {
      console.error('Error fetching user history:', error);
      return getTopRatedMovies();
    }

    if (!history || history.length === 0) {
      console.log('No history found for user, returning top-rated movies');
      return getTopRatedMovies();
    }

    // Prepare movie history for Gemini
    const movieList = history.map(h => `${h.movie_title} (Rating: ${h.movie_rating})`).join(', ');
    
    const genreList = "Action, Adventure, Animation, Comedy, Crime, Documentary, Drama, Family, Fantasy, History, Horror, Music, Mystery, Romance, Science Fiction, TV Movie, Thriller, War, Western";
    
    const prompt = `
      Based on a user's movie watching history, suggest 1-3 genres that would best match their preferences.
      
      User's recently watched movies: ${movieList}
      
      From the following list of official TMDB movie genres, choose the 1-3 best genres that represent this user's preferences:
      ${genreList}

      Return ONLY a comma-separated list of genre names, and nothing else.
      Your response should not contain any special formatting, quotes, or introductory text.

      Example response:
      Action, Thriller

      Now, provide the best genres for this user's preferences:
    `;

    const result = await model.generateContent(prompt);
    const genreNames = result.response.text().trim().split(',').map(g => g.trim().toLowerCase());
    console.log(`Gemini suggested genres based on history:`, genreNames);

    // Map genre names to TMDB genre IDs
    const genreIds = genreNames
      .map(name => TMDB_GENRE_MAP[name])
      .filter(Boolean)
      .join(',');

    if (!genreIds) {
      console.warn(`Could not find valid TMDB genres for "${genreNames}". Falling back to top-rated movies.`);
      return getTopRatedMovies();
    }

    // Use TMDB Discover endpoint with suggested genres
    const discoverUrl = `/discover/movie?language=en-US&sort_by=vote_average.desc&vote_count.gte=100&include_adult=false&with_genres=${genreIds}&page=1`;
    const discoverResponse = await tmdbAxios.get(discoverUrl);

    if (!discoverResponse.data || !discoverResponse.data.results || discoverResponse.data.results.length === 0) {
      console.warn(`Discovery for personalized genres returned no results. Falling back to top-rated movies.`);
      return getTopRatedMovies();
    }

    return discoverResponse.data.results.slice(0, 20).map(formatTmdbMovie);
  } catch (error) {
    console.error('Error getting personalized recommendations:', error);
    return getTopRatedMovies();
  }
};

/**
 * Fetches the most watched movies (using "now playing" as a proxy for current engagement).
 * @returns {Promise<Array>} A promise that resolves to a list of most watched movies.
 */
const getMostWatchedMovies = async () => {
  const url = '/movie/now_playing?language=en-US&page=1';
  const response = await tmdbAxios.get(url);
  if (!response.data || !response.data.results) {
    throw new Error('Failed to fetch most watched movies from TMDB.');
  }
  // Sort by popularity and vote count to get truly "most watched" feel
  const sortedMovies = response.data.results
    .filter(movie => movie.vote_count > 100) // Filter movies with sufficient votes
    .sort((a, b) => (b.popularity * b.vote_count) - (a.popularity * a.vote_count))
    .slice(0, 20);
  
  return sortedMovies.map(formatTmdbMovie);
};

// --- Hardcoded TMDB Genre Name to ID Map ---
const TMDB_GENRE_MAP = {
  "action": 28,
  "adventure": 12,
  "animation": 16,
  "comedy": 35,
  "crime": 80,
  "documentary": 99,
  "drama": 18,
  "family": 10751,
  "fantasy": 14,
  "history": 36,
  "horror": 27,
  "music": 10402,
  "mystery": 9648,
  "romance": 10749,
  "science fiction": 878,
  "tv movie": 10770,
  "thriller": 53,
  "war": 10752,
  "western": 37,
};

// --- API Server Setup ---
app.use(cors());
app.use(express.json());

// Endpoint for top-rated movies
app.get('/api/top-rated', async (req, res) => {
  try {
    console.log("Fetching top-rated movies...");
    const movies = await getTopRatedMovies();
    res.status(200).json(movies);
  } catch (error) {
    console.error('Error fetching top-rated movies:', error);
    res.status(500).json({ error: 'Failed to get top-rated movies.' });
  }
});

// Endpoint for popular movies
app.get('/api/popular', async (req, res) => {
  try {
    console.log("Fetching popular movies...");
    const movies = await getPopularMovies();
    res.status(200).json(movies);
  } catch (error) {
    console.error('Error fetching popular movies:', error);
    res.status(500).json({ error: 'Failed to get popular movies.' });
  }
});

// Endpoint for mood-based recommendations
app.get('/api/recommendations', async (req, res) => {
  const { mood } = req.query;

  if (!mood || typeof mood !== 'string') {
    return res.status(400).json({ error: 'A "mood" query parameter is required.' });
  }

  try {
    console.log(`Getting recommendations for mood: "${mood}"`);
    const movies = await getMoodRecommendations(mood);
    res.status(200).json(movies);
  } catch (error) {
    console.error('Error processing recommendation request:', error);
    res.status(500).json({ error: 'Failed to get recommendations.' });
  }
});

// Add new endpoint for personalized recommendations
app.get('/api/personalized', async (req, res) => {
  const { userId } = req.query;

  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'A "userId" query parameter is required.' });
  }

  try {
    console.log(`Getting personalized recommendations for user: ${userId}`);
    const movies = await getPersonalizedRecommendations(userId);
    res.status(200).json(movies);
  } catch (error) {
    console.error('Error processing personalized recommendation request:', error);
    res.status(500).json({ error: 'Failed to get personalized recommendations.' });
  }
});

// Add endpoint to track movie clicks (SIMPLIFIED VERSION)
app.post('/api/track-click', async (req, res) => {
  const { userId, movieId, movieTitle, movieGenreIds, movieRating } = req.body;

  if (!userId || !movieId || !movieTitle) {
    return res.status(400).json({ error: 'userId, movieId, and movieTitle are required.' });
  }

  // Validate UUID format for userId
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(userId)) {
    return res.status(400).json({ error: 'userId must be a valid UUID format.' });
  }

  try {
    // Check if record already exists
    const { data: existingRecord, error: checkError } = await supabase
      .from('movie_history')
      .select('id, clicked_at')
      .eq('user_id', userId)
      .eq('movie_id', movieId)
      .single();

    if (checkError && checkError.code !== 'PGRST116') { // PGRST116 means no rows found
      console.error('Error checking existing record:', checkError);
    }

    const currentTime = new Date().toISOString();

    if (existingRecord) {
      // Update existing record with new timestamp
      const { data: updateData, error: updateError } = await supabase
        .from('movie_history')
        .update({ 
          clicked_at: currentTime,
          movie_title: movieTitle, // Update title in case it changed
          movie_genre_ids: movieGenreIds || [],
          movie_rating: movieRating || 0
        })
        .eq('id', existingRecord.id);

      if (updateError) {
        console.error('Error updating movie click:', updateError);
        return res.status(500).json({ error: 'Failed to update movie click record.' });
      }

      console.log('Movie click updated successfully:', movieTitle, 'for user:', userId);
      res.status(200).json({ 
        message: 'Movie click updated successfully.',
        action: 'updated',
        previousClick: existingRecord.clicked_at
      });
    } else {
      // Insert new record
      const { data: insertData, error: insertError } = await supabase
        .from('movie_history')
        .insert([
          {
            user_id: userId,
            movie_id: movieId,
            movie_title: movieTitle,
            movie_genre_ids: movieGenreIds || [],
            movie_rating: movieRating || 0,
            clicked_at: currentTime
          }
        ]);

      if (insertError) {
        console.error('Error inserting movie click:', insertError);
        
        // Handle specific database constraint errors
        if (insertError.code === '23503' && (insertError.message.includes('fk_movie_history_user') || insertError.message.includes('fk_userid'))) {
          return res.status(400).json({ 
            error: 'Invalid user ID. User does not exist in the authentication system.',
            details: 'Please ensure you are properly authenticated before tracking movie clicks. The user ID must belong to a valid authenticated user.'
          });
        } else if (insertError.code === '22P02') {
          return res.status(400).json({ 
            error: 'Invalid user ID format. User ID must be a valid UUID.',
            details: 'Please provide a valid UUID for the userId field.'
          });
        }
        
        return res.status(500).json({ error: 'Failed to track movie click.' });
      }

      console.log('Movie click tracked successfully:', movieTitle, 'for user:', userId);
      res.status(200).json({ 
        message: 'Movie click tracked successfully.',
        action: 'inserted'
      });
    }
  } catch (error) {
    console.error('Error tracking movie click:', error);
    res.status(500).json({ error: 'Failed to track movie click.' });
  }
});

// --- User History Endpoints ---

// Get user's movie history with pagination and filtering
app.get('/api/user-history', async (req, res) => {
  const { userId, limit = 20, offset = 0, sortBy = 'clicked_at', order = 'desc' } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'userId query parameter is required.' });
  }

  // Validate UUID format for userId
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(userId)) {
    return res.status(400).json({ error: 'userId must be a valid UUID format.' });
  }

  try {
    const limitInt = parseInt(limit);
    const offsetInt = parseInt(offset);
    
    // Validate sort parameters
    const allowedSortFields = ['clicked_at', 'movie_title', 'movie_rating'];
    const allowedOrders = ['asc', 'desc'];
    
    if (!allowedSortFields.includes(sortBy)) {
      return res.status(400).json({ error: 'Invalid sortBy field. Allowed: clicked_at, movie_title, movie_rating' });
    }
    
    if (!allowedOrders.includes(order.toLowerCase())) {
      return res.status(400).json({ error: 'Invalid order. Allowed: asc, desc' });
    }

    // Get total count
    const { count: totalCount, error: countError } = await supabase
      .from('movie_history')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (countError) {
      console.error('Error getting history count:', countError);
      return res.status(500).json({ error: 'Failed to get history count.' });
    }

    // Get paginated history
    const { data: history, error: historyError } = await supabase
      .from('movie_history')
      .select('*')
      .eq('user_id', userId)
      .order(sortBy, { ascending: order.toLowerCase() === 'asc' })
      .range(offsetInt, offsetInt + limitInt - 1);

    if (historyError) {
      console.error('Error fetching user history:', historyError);
      return res.status(500).json({ error: 'Failed to fetch user history.' });
    }

    // Add "watched ago" formatting and genre names
    const enhancedHistory = history.map(item => {
      const clickedAt = new Date(item.clicked_at);
      const now = new Date();
      const diffInMs = now - clickedAt;
      const diffInMinutes = Math.floor(diffInMs / (1000 * 60));
      const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60));
      const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));

      let watchedAgo;
      if (diffInMinutes < 60) {
        watchedAgo = diffInMinutes <= 1 ? 'Just now' : `${diffInMinutes} minutes ago`;
      } else if (diffInHours < 24) {
        watchedAgo = diffInHours === 1 ? '1 hour ago' : `${diffInHours} hours ago`;
      } else if (diffInDays < 30) {
        watchedAgo = diffInDays === 1 ? '1 day ago' : `${diffInDays} days ago`;
      } else {
        watchedAgo = clickedAt.toLocaleDateString();
      }

      // Map genre IDs to names
      const genreMap = {
        28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
        99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
        27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Science Fiction',
        10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western'
      };

      const genreNames = (item.movie_genre_ids || []).map(id => genreMap[id]).filter(Boolean);

      return {
        ...item,
        watchedAgo,
        genreNames
      };
    });

    const hasMore = offsetInt + limitInt < totalCount;

    console.log(`User history fetched for ${userId}: ${history.length} items, total: ${totalCount}`);
    res.status(200).json({
      history: enhancedHistory,
      totalCount,
      hasMore,
      currentPage: Math.floor(offsetInt / limitInt) + 1,
      totalPages: Math.ceil(totalCount / limitInt)
    });

  } catch (error) {
    console.error('Error fetching user history:', error);
    res.status(500).json({ error: 'Failed to fetch user history.' });
  }
});

// Endpoint for most watched movies
app.get('/api/most-watched', async (req, res) => {
  try {
    console.log("Fetching most watched movies...");
    const movies = await getMostWatchedMovies();
    res.status(200).json(movies);
  } catch (error) {
    console.error('Error fetching most watched movies:', error);
    res.status(500).json({ error: 'Failed to get most watched movies.' });
  }
});

// Add endpoint to get user's movie history
app.get('/api/user-history', async (req, res) => {
  const { userId, limit = 20, offset = 0, sortBy = 'clicked_at', order = 'desc' } = req.query;

  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'A valid "userId" query parameter is required.' });
  }

  // Validate UUID format for userId
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(userId)) {
    return res.status(400).json({ error: 'userId must be a valid UUID format.' });
  }

  try {
    console.log(`Fetching movie history for user: ${userId}`);
    
    // Get user's movie history with pagination
    const { data: history, error, count } = await supabase
      .from('movie_history')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order(sortBy, { ascending: order === 'asc' })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (error) {
      console.error('Error fetching user history:', error);
      return res.status(500).json({ error: 'Failed to fetch user history.' });
    }

    console.log(`Found ${history?.length || 0} history entries for user`);
    
    // Transform the data to include additional computed fields
    const enrichedHistory = history?.map(entry => ({
      ...entry,
      watchedAgo: getTimeAgo(entry.clicked_at),
      genreNames: getGenreNames(entry.movie_genre_ids || [])
    })) || [];

    res.status(200).json({
      history: enrichedHistory,
      totalCount: count,
      currentPage: Math.floor(parseInt(offset) / parseInt(limit)) + 1,
      totalPages: Math.ceil(count / parseInt(limit)),
      hasMore: (parseInt(offset) + parseInt(limit)) < count
    });

  } catch (error) {
    console.error('Error processing user history request:', error);
    res.status(500).json({ error: 'Failed to fetch user history.' });
  }
});

// Helper function to calculate time ago
const getTimeAgo = (dateString) => {
  const now = new Date();
  const clickedAt = new Date(dateString);
  const diffInMs = now - clickedAt;
  const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));
  const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60));
  const diffInMinutes = Math.floor(diffInMs / (1000 * 60));

  if (diffInDays > 0) {
    return `${diffInDays} day${diffInDays > 1 ? 's' : ''} ago`;
  } else if (diffInHours > 0) {
    return `${diffInHours} hour${diffInHours > 1 ? 's' : ''} ago`;
  } else if (diffInMinutes > 0) {
    return `${diffInMinutes} minute${diffInMinutes > 1 ? 's' : ''} ago`;
  } else {
    return 'Just now';
  }
};

// Helper function to convert genre IDs to names
const getGenreNames = (genreIds) => {
  const genreIdToName = Object.fromEntries(
    Object.entries(TMDB_GENRE_MAP).map(([name, id]) => [id, name])
  );
  
  return genreIds.map(id => genreIdToName[id]).filter(Boolean).map(name => 
    name.charAt(0).toUpperCase() + name.slice(1)
  );
};

// Import additional modules for party functionality
import { WebSocketServer } from 'ws';
import { v4 } from "uuid";
import { Kafka } from 'kafkajs';
import { createClient as createClient2 } from 'redis';

// Party-related global variables
const partyRooms = new Map();

const redisUrl = process.env.REDIS_URL;

const client = createClient2({
  url: redisUrl
});
const subscriber = client.duplicate();
client.on('error', (err) => console.log('Redis Client Error', err));

async function connectRedis() {
  try {
    await client.connect();
    await subscriber.connect();
    console.log("Connected to Redis successfully!");
  } catch (e) {
    console.error("Couldn't connect to Redis:", e);
    process.exit(1); 
  }
}
connectRedis()

const kafka = new Kafka({
  clientId : "watch-party-app",
  brokers : ['localhost:9092']
})
const producer = kafka.producer();

async function sendKafkaEvent(topic, payload) {
  try {
    await producer.send({
      topic: topic,
      messages: [{ value: JSON.stringify(payload) }],
    });
    console.debug("kafka message sent successfully to topic", topic);
  } catch (error) {
    console.error(`Failed to send event to Kafka topic ${topic}:`, error);
  }
}

// Party endpoints
app.post('/party', async (req, res) => {
  if (!req.body.mediaId || !req.body.hostId) {
    console.log("Invalid request");
    res.status(400);
    res.send("Invalid request");
    return;
  }
        
  const partyId = v4();
  const redisKey = `party:${partyId}`;
  
  const time = new Date();
  const partyVal = {
    "mediaId": req.body.mediaId,
    "hostId": req.body.hostId,
    "createdAt": time.toISOString(),
    "playbackState": "paused",
    "timestamp": 0             
  }
  
  sendKafkaEvent('party-events',{
    "timestamp" : time.toISOString(),
    "partyId" : partyId,
    "userId" : req.body.hostId,
    "mediaId" : req.body.mediaId,
    "eventType" : "create-party"
  })
  
  const serverHost = process.env.HOST;
  const url = `${serverHost}/party/${partyId}`;

  client.set(redisKey,JSON.stringify(partyVal));
  client.expire(redisKey,60*60*24)

  res.status(201);
  res.send({
    "id": partyId,
    "url": url,
    "partyVal" :partyVal
  })
})

app.get('/party/:partyId', async(req, res) => {
  const partyId = req.params.partyId
  if (!partyId){
    console.log("Invalid request");
    res.status(400);
    res.send("Invalid request");
    return;
  }

  const redisKey = `party:${partyId}`
  const partyVal = await client.get(redisKey)
  if (!partyVal){
    res.status(404)
    res.send({"error" : `Invalid URL or the party has expired.`})
    return;
  }

  res.status(200)
  res.send(JSON.parse(partyVal))
})

app.put('/party/:partyId/state', async (req, res) => {
  const partyId = req.params.partyId;
  const { timestamp, playbackState } = req.body;

  if (!partyId || timestamp === undefined || !playbackState) {
    console.log("Invalid request - missing partyId, timestamp, or playbackState");
    res.status(400).send("Invalid request");
    return;
  }

  try {
    const redisKey = `party:${partyId}`;
    const partyDataString = await client.get(redisKey);
    
    if (!partyDataString) {
      res.status(404).send({"error": "Party not found or has expired"});
      return;
    }

    const partyData = JSON.parse(partyDataString);
    
    // Update the party state
    partyData.timestamp = parseFloat(timestamp);
    partyData.playbackState = playbackState;
    
    // Save back to Redis
    await client.set(redisKey, JSON.stringify(partyData));
    
    console.log(`Updated party ${partyId} state: ${playbackState} at ${timestamp}s`);
    
    res.status(200).send({
      success: true,
      timestamp: partyData.timestamp,
      playbackState: partyData.playbackState
    });
    
  } catch (error) {
    console.error("Error updating party state:", error);
    res.status(500).send("Internal server error");
  }
});

const server = app.listen(PORT, () => {
  console.log(`🚀 Server is running at http://localhost:${PORT}`);
});

const wss = new WebSocketServer({ server });

wss.on('connection', function connection(ws, req) {
  // gets params from url
  const params = new URLSearchParams(req.url.split("?")[1]);
  const partyId = params.get("partyId");
  const userId = params.get("userId")

  // missing params reject connection
  if (!partyId || !userId) {
    console.log("Connection rejected: No partyId or userId provided.");
    ws.close();
    return;
  }

  // adds ws connection to dedicated party room
  ws.partyId = partyId;
  ws.userId = userId;
  if (!partyRooms.get(partyId)) {
    partyRooms.set(partyId, new Set());
  }
  partyRooms.get(partyId).add(ws);

  sendKafkaEvent('user-events',{
    "timestamp" : new Date().toISOString(),
    "userId" : userId,
    "partyId" : partyId,
    "eventType" : "join-party"
  })

  // check for addition of ws to party room
  console.log(`party ${partyId} now has ${partyRooms.get(partyId).size} members`);
  
  // receives message -> sends to pub-sub
  ws.on('message', function message(data) {
    try{
      data = JSON.parse(data.toString());
    }catch(e){
      console.log(e);
      console.log("message is not json")
      return;
    }

    if (data.type == "controls" || data.type == "chat" || data.type == "user_joined" || data.type == "user_left"){
      const channel = `party-${data.type}:${partyId}`;
      client.publish(channel,JSON.stringify(data))
      
      // Log different event types
      let eventType = "message-sent";
      let messageContent = "";
      
      if (data.type === "user_joined") {
        eventType = "user-joined";
        messageContent = `User ${data.username || data.userId} joined`;
      } else if (data.type === "user_left") {
        eventType = "user-left";
        messageContent = `User ${data.username || data.userId} left`;
      } else if (data.type === "chat") {
        eventType = "message-sent";
        messageContent = "chat messages are not stored to protect user privacy";
      } else if (data.type === "controls") {
        eventType = "message-sent";
        messageContent = data.message;
      }
      
      sendKafkaEvent('engagement-events',{
        "timestamp" : new Date().toISOString(),
        "userId" : userId,
        "partyId" : partyId,
        "eventType" : eventType,
        "messageType" : data.type,
        "messageContent" : messageContent
      })
    }else{
      console.log("invalid message type : must be 'controls', 'chat', 'user_joined', or 'user_left'");
    }
  });

  ws.on('close', async function close() {
    console.log(`client disconneted from party ${partyId}`);

    const room = partyRooms.get(partyId);
    
    if (room){
      room.delete(ws);
      console.log(`party ${partyId} now has ${partyRooms.get(partyId).size} members`);
      sendKafkaEvent('user-events',{
        "timestamp" : new Date().toISOString(),
        "userId" : userId,
        "partyId" : partyId,
        "eventType" : "leave-party"
      })

      const partyDataString = await client.get(`party:${partyId}`);
      if (partyDataString){
        const partyDetails = JSON.parse(partyDataString);

        if (partyDetails.hostId == userId){
          console.log(`Host has left. Ending party ${partyId}`);

          const endMsg = JSON.stringify({
            "type" : 'controls',
            'message' : 'party_ended_by_host'
          })
          client.publish(`party-controls:${partyId}`,endMsg);
          await client.del(`party:${partyId}`);
          sendKafkaEvent('party-events',{
            "timestamp" : new Date().toISOString(),
            "userId" : userId,
            "partyId" : partyId,
            "eventType" : "end-party"
          })
        }
      }
    }
  });

  ws.send('welcome to the party');
});

subscriber.pSubscribe(['party-controls:*','party-chat:*','party-user_joined:*','party-user_left:*'],(message,channel) => {
  const partyId = channel.split(":")[1];
  const room = partyRooms.get(partyId)
  if (room){
    const msgObj = JSON.parse(message.toString())
    for (const client of room){
      client.send(message)
    }
    if (msgObj.type == 'controls' && msgObj.message == 'party_ended_by_host'){
      for (const client of room){
        client.close(1000,"party ended by host")
      }
      partyRooms.delete(partyId); 
    }
  }
})

// Add endpoint to delete specific movie from user history
app.delete('/api/user-history/:movieId', async (req, res) => {
  const { movieId } = req.params;
  const { userId } = req.body;

  if (!userId || !movieId) {
    return res.status(400).json({ error: 'userId and movieId are required.' });
  }

  // Validate UUID format for userId
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(userId)) {
    return res.status(400).json({ error: 'userId must be a valid UUID format.' });
  }

  try {
    console.log(`Deleting movie ${movieId} from history for user: ${userId}`);
    
    const { data, error } = await supabase
      .from('movie_history')
      .delete()
      .eq('user_id', userId)
      .eq('movie_id', movieId);

    if (error) {
      console.error('Error deleting movie from history:', error);
      return res.status(500).json({ error: 'Failed to delete movie from history.' });
    }

    console.log('Movie deleted from history successfully');
    res.status(200).json({ message: 'Movie deleted from history successfully.' });

  } catch (error) {
    console.error('Error processing delete request:', error);
    res.status(500).json({ error: 'Failed to delete movie from history.' });
  }
});

// Add endpoint to clear all user history
app.delete('/api/user-history/clear', async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required.' });
  }

  // Validate UUID format for userId
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(userId)) {
    return res.status(400).json({ error: 'userId must be a valid UUID format.' });
  }

  try {
    console.log(`Clearing all history for user: ${userId}`);
    
    const { data, error } = await supabase
      .from('movie_history')
      .delete()
      .eq('user_id', userId);

    if (error) {
      console.error('Error clearing user history:', error);
      return res.status(500).json({ error: 'Failed to clear user history.' });
    }

    console.log('User history cleared successfully');
    res.status(200).json({ message: 'User history cleared successfully.' });

  } catch (error) {
    console.error('Error processing clear history request:', error);
    res.status(500).json({ error: 'Failed to clear user history.' });
  }
});