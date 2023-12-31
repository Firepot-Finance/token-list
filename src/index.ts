import * as functions from '@google-cloud/functions-framework';
import { createClient } from 'redis';
import fetch from 'node-fetch';

interface ClearCacheQuery {
  clearCache: string;
}

type Size = 'xs' | 'sm' | 'lg';

interface Query {
  symbol: string;
  size: Size;
}

interface Token {
  id: string;
  symbol: string;
  name: string;
}

interface TokenImageUrl {
  thumb: string;
  small: string;
  large: string;
}

interface TokenDetails {
  id: string;
  image: TokenImageUrl;
  market_cap_rank: number | null;
}

const REDISHOST = process.env.REDISHOST || 'localhost';
const REDISPORT = Number(process.env.REDISPORT) || 6379;

const redisClient = createClient({
  socket: {
    host: REDISHOST,
    port: REDISPORT,
  },
});
redisClient.on('error', (err: any) => console.error('ERR:REDIS:', err));
redisClient.connect();

const getTokenListFromCache = async (tokenListKey: string) => {
  console.log('getTokenListFromCache');
  const tokenListString = await redisClient.get(tokenListKey);
  const tokenList = tokenListString ? JSON.parse(tokenListString) as Token[] : null;
  return tokenList;
}

const getTokenImageFromCache = async (tokenImageKey: string) => {
  console.log('getTokenImageFromCache');
  const tokenImageBase64 = await redisClient.get(tokenImageKey);
  return tokenImageBase64 ? Buffer.from(tokenImageBase64, 'base64') : null;
}

const getTokenListFromCoingecko = async () => {
  console.log('getTokenListFromCoingecko');
  const response = await fetch(`https://api.coingecko.com/api/v3/coins/list`);
  if (!response.ok) {
      throw new Error(`Error fetching token list from CoinGecko: ${response.statusText}`);
  }
  const tokenList = await response.json() as Token[];
  if (!tokenList) {
      throw new Error(`Token list not found on CoinGecko`);
  }
  return tokenList;
}

const getTopTokenImageFromCoingecko = async (tokenList: Token[], size: Size) => {
  console.log('getTokenImageFromCoingecko');
  
  const fetchDetails = async (t: Token) => {
    try {
      const response = await fetch(`https://api.coingecko.com/api/v3/coins/${t.id}`);
      if (!response.ok) {
        throw new Error(`Error fetching details for token ${t.id}: ${response.statusText}`);
      }
      const details = await response.json() as TokenDetails;
      return {
        id: details.id,
        image: details.image,
        market_cap_rank: details.market_cap_rank
      };
    } catch (err) {
      console.error(`Error fetching details for token ${t.id}:`, err);
      throw err;
    }
  };
  
  const multipleTokens = await Promise.all(tokenList.map(fetchDetails));

  const sortedTokens = multipleTokens.sort((a, b) => {
    if (a.market_cap_rank === null) return 1;
    if (b.market_cap_rank === null) return -1;
    return a.market_cap_rank - b.market_cap_rank;
  });
  
  const lowestRankToken = sortedTokens[0];
  
  let tokenImageUrl: string;
  switch (size) {
    case 'xs': tokenImageUrl = lowestRankToken.image.thumb; break;
    case 'sm': tokenImageUrl = lowestRankToken.image.small; break;
    case 'lg': tokenImageUrl = lowestRankToken.image.large; break;
  }
  
  const tokenImageResponse = await fetch(tokenImageUrl);
  if (!tokenImageResponse.ok) {
    throw new Error(`Error fetching token image from CoinGecko: ${tokenImageResponse.statusText}`);
  }
  
  const tokenImageArrayBuffer = await tokenImageResponse.arrayBuffer();
  return Buffer.from(tokenImageArrayBuffer);
}

const getImageFormat = (buffer: Buffer) => {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return 'jpeg';
  } else if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'png';
  } else if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return 'gif';
  } else if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return 'bmp';
  } else {
    return 'unknown';
  }
}

function isClearCacheQuery(obj: any): obj is ClearCacheQuery {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    ['true', 'false'].includes(obj.clearCache)
  );
}

function isQuery(obj: any): obj is Query {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    typeof obj.symbol === 'string' &&
    ['xs', 'sm', 'lg'].includes(obj.size)
  );
}

functions.http('tokenImage', async (req: any, res: any) => {
  const query = req.query;
  if (isClearCacheQuery(query) && query.clearCache === 'true') {
    await redisClient.flushDb();
    return res.status(200).json({ message: 'Cache cleared' });
  }
  if (!isQuery(query)) {
    const err = { error: 'Invalid query' };
    console.error(err);
    return res.status(400).json(err);
  }

  const tokenSymbol = query.symbol;
  const imageSize = query.size;
  const tokenListKey = 'tokenList';
  const tokenImageKey = `tokenImage:${tokenSymbol}-${imageSize}`;

  let tokenImage: Buffer | null = null;

  try {
    tokenImage = await getTokenImageFromCache(tokenImageKey);
  } catch (err) {
    console.error('Error fetching token image from cache:', err);
  }

  if (!tokenImage) {
    let tokenList: Token[] | null = null;

    try {
      tokenList = await getTokenListFromCache(tokenListKey)
    } catch (err) {
      console.error('Error fetching token list from cache:', err);
    }

    if (!tokenList) {
      try {
        tokenList = await getTokenListFromCoingecko();
        redisClient.set(tokenListKey, JSON.stringify(tokenList));
      } catch (err) {
        console.error('Error fetching token list from Coingecko:', err);
        return res.status(500).json({ error: `Error fetching token list:: ${err}` });
      }
    }

    let matchingTokens = tokenList.filter((t) => t.symbol === tokenSymbol.toLowerCase());
    console.warn(matchingTokens);
    
    try {
      tokenImage = await getTopTokenImageFromCoingecko(matchingTokens, imageSize);
      if (!tokenImage) {
        throw new Error(`Token image not found on CoinGecko`);
      }
    } catch (err) {
      console.error('Error fetching token image from Coingecko:', err);
      return res.status(404).json({ error: `Token image not found:: ${err}` });
    }
  }

  const tokenImageBase64 = tokenImage.toString('base64');
  redisClient.set(tokenImageKey, tokenImageBase64);
  const imageFormat = getImageFormat(tokenImage);
  console.log('imageFormat', imageFormat);
  res.set('Content-Type', `image/${imageFormat}`).send(tokenImage);
});
