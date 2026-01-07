import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { ANIME } from '@consumet/extensions';
import { StreamingServers, SubOrSub } from '@consumet/extensions/dist/models';

import cache from '../../utils/cache';
import { redis, REDIS_TTL } from '../../main';
import { Redis } from 'ioredis';

import axios from 'axios';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  const hianime = new ANIME.Hianime();

  fastify.get('/', (_, rp) => {
    rp.status(200).send({
      intro: `Welcome to the hianime provider: check out the provider's website @ ${hianime.toString.baseUrl}`,
      routes: [
        '/:query',
        '/info',
        '/watch/:episodeId',
        '/advanced-search',
        '/top-airing',
        '/most-popular',
        '/most-favorite',
        '/latest-completed',
        '/recently-updated',
        '/recently-added',
        '/top-upcoming',
        '/studio/:studio',
        '/subbed-anime',
        '/dubbed-anime',
        '/movie',
        '/tv',
        '/ova',
        '/ona',
        '/special',
        '/genres',
        '/genre/:genre',
        '/schedule',
        '/spotlight',
        '/search-suggestions/:query',
      ],
      documentation: 'https://docs.consumet.org/#tag/hianime',
    });
  });

  fastify.get('/:query', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.params as { query: string }).query;
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `hianime:search:${query}:${page}`,
            async () => await hianime.search(query, page),
            REDIS_TTL,
          )
        : await hianime.search(query, page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/info', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.query as { id: string }).id;

    if (typeof id === 'undefined')
      return reply.status(400).send({ message: 'id is required' });

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `hianime:info:${id}`,
            async () => await hianime.fetchAnimeInfo(id),
            REDIS_TTL,
          )
        : await hianime.fetchAnimeInfo(id);

      if (res && Array.isArray(res.episodes)) {
        res.episodes = res.episodes.map((episode) => ({
            ...episode,
            id: episode.id.endsWith("$both") ? episode.id : `${episode.id}$both`
        }));
      }

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  const watch = async (request: FastifyRequest, reply: FastifyReply) => {
      let episodeId = (request.params as { episodeId: string }).episodeId;

      if(!episodeId){
        episodeId = (request.query as { episodeId: string }).episodeId;
      }

      if (episodeId.includes("/watch/")) 
      {
        let episodeIdAux = episodeId.replace("/watch/", "");
        let episodeIdAuxParts = episodeIdAux.split("?ep=");
        episodeId = episodeIdAuxParts[ 0 ] + "$episode$" + episodeIdAuxParts[ 1 ];      
      }

      const server = (request.query as { server: StreamingServers }).server;
      let category = (request.query as { category: SubOrSub }).category;

      let dub = (request.query as { dub?: string | boolean }).dub;
      if (dub === 'true' || dub === '1') dub = true;
      else dub = false;

      dub = episodeId.includes('$dub');

      category = dub === true ? SubOrSub.DUB : SubOrSub.SUB

      if (typeof episodeId === 'undefined')
        return reply.status(400).send({ message: 'episodeId is required' });

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `hianime:watch:${episodeId}:${server}:${category}`,
              async () => await hianime.fetchEpisodeSources(episodeId, server, category),
              REDIS_TTL,
            )
          : await hianime.fetchEpisodeSources(episodeId, server, category);

        for (let index = 0; index < res.sources.length; index++) {
          let obj = res.sources[index];
          if (!obj.hasOwnProperty('quality')) {
            obj.quality = "AUTO";
          }else if( obj?.quality !== undefined && obj.quality == "auto" )
          {
            obj.quality = "AUTO";
          }
        }

        if ( res.subtitles != null ) 
        {
          for (let index = 0; index < res.subtitles.length; index++) {
            if ( res.subtitles[ index ].lang == "Thumbnails" || res.subtitles[ index ].lang == "thumbnails" ) 
            {
              res.subtitles.splice(index, 1);
            }
          } 
        }    

        if ( res.sources == undefined || res.sources.length == 0 ) 
        {      
          const parts = episodeId.split('$');        
          const resAniwatch = await fetchEpisodeSources(parts[0], parts[2], false, parts[3]);
          if (resAniwatch != null) 
          {
            res = resAniwatch;
          }else{
            const resAniwatchRaw = await fetchEpisodeSources(parts[0], parts[2], true, parts[3]);
            if (resAniwatchRaw != null) 
            {
              res = resAniwatchRaw;
            }      
          }        
        }

        reply.status(200).send(res);
      } catch (err) {
        const parts = episodeId.split('$');
        try {
          const data = await fetchEpisodeSources(parts[0], parts[2], false, parts[3]);
          if (data != null) 
          {
            reply.status(200).send(data);  // Solo se envía la respuesta cuando tenemos los datos 
          }else{
            try {
              const data = await fetchEpisodeSources(parts[0], parts[2], true, parts[3]);
              if (data != null) 
              {
                reply.status(200).send(data);  // Solo se envía la respuesta cuando tenemos los datos 
              }else{
                reply.status(500).send({});
              }
            } catch (error) {
              reply.status(500).send({ message: 'Something went wrong. Contact developer for help.' });
            }
          }
        } catch (error) {
          reply.status(500).send({ message: 'Something went wrong. Contact developer for help.' });
        }
      }
    };

  fastify.get('/watch', watch);
  fastify.get('/watch/:episodeId', watch);
  fastify.get('/watch_aux', watch);
  fastify.get('/watch_aux/:episodeId', watch);

  fastify.get('/genres', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `hianime:genres`,
            async () => await hianime.fetchGenres(),
            REDIS_TTL,
          )
        : await hianime.fetchGenres();

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/schedule', async (request: FastifyRequest, reply: FastifyReply) => {
    const date = (request.query as { date: string }).date;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `hianime:schedule:${date}`,
            async () => await hianime.fetchSchedule(date),
            REDIS_TTL,
          )
        : await hianime.fetchSchedule(date);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/spotlight', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `hianime:spotlight`,
            async () => await hianime.fetchSpotlight(),
            REDIS_TTL,
          )
        : await hianime.fetchSpotlight();

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get(
    '/search-suggestions/:query',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = (request.params as { query: string }).query;

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `hianime:suggestions:${query}`,
              async () => await hianime.fetchSearchSuggestions(query),
              REDIS_TTL,
            )
          : await hianime.fetchSearchSuggestions(query);

        reply.status(200).send(res);
      } catch (err) {
        reply
          .status(500)
          .send({ message: 'Something went wrong. Contact developer for help.' });
      }
    },
  );

  fastify.get(
    '/advanced-search',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const queryParams = request.query as {
        page?: number;
        type?: string;
        status?: string;
        rated?: string;
        score?: number;
        season?: string;
        language?: string;
        startDate?: string;
        endDate?: string;
        sort?: string;
        genres?: string;
      };

      const {
        page = 1,
        type,
        status,
        rated,
        score,
        season,
        language,
        startDate,
        endDate,
        sort,
        genres,
      } = queryParams;

      try {
        // Explicitly typed to avoid implicit any errors
        let parsedStartDate: { year: number; month: number; day: number } | undefined;
        let parsedEndDate: { year: number; month: number; day: number } | undefined;

        if (startDate) {
          const [year, month, day] = startDate.split('-').map(Number);
          parsedStartDate = { year, month, day };
        }
        if (endDate) {
          const [year, month, day] = endDate.split('-').map(Number);
          parsedEndDate = { year, month, day };
        }

        const genresArray = genres ? genres.split(',') : undefined;

        // Create a unique key based on all parameters
        const cacheKey = `hianime:advanced-search:${JSON.stringify(queryParams)}`;

        let res = redis
          ? await cache.fetch(
              redis as Redis,
              cacheKey,
              async () =>
                await hianime.fetchAdvancedSearch(
                  page,
                  type,
                  status,
                  rated,
                  score,
                  season,
                  language,
                  parsedStartDate,
                  parsedEndDate,
                  sort,
                  genresArray,
                ),
              REDIS_TTL,
            )
          : await hianime.fetchAdvancedSearch(
              page,
              type,
              status,
              rated,
              score,
              season,
              language,
              parsedStartDate,
              parsedEndDate,
              sort,
              genresArray,
            );

        reply.status(200).send(res);
      } catch (err) {
        reply
          .status(500)
          .send({ message: 'Something went wrong. Contact developer for help.' });
      }
    },
  );

  fastify.get('/top-airing', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `hianime:top-airing:${page}`,
            async () => await hianime.fetchTopAiring(page),
            REDIS_TTL,
          )
        : await hianime.fetchTopAiring(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/most-popular', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `hianime:most-popular:${page}`,
            async () => await hianime.fetchMostPopular(page),
            REDIS_TTL,
          )
        : await hianime.fetchMostPopular(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/most-favorite', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `hianime:most-favorite:${page}`,
            async () => await hianime.fetchMostFavorite(page),
            REDIS_TTL,
          )
        : await hianime.fetchMostFavorite(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get(
    '/latest-completed',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const page = (request.query as { page: number }).page;

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `hianime:latest-completed:${page}`,
              async () => await hianime.fetchLatestCompleted(page),
              REDIS_TTL,
            )
          : await hianime.fetchLatestCompleted(page);

        reply.status(200).send(res);
      } catch (err) {
        reply
          .status(500)
          .send({ message: 'Something went wrong. Contact developer for help.' });
      }
    },
  );

  fastify.get(
    '/recently-updated',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const page = (request.query as { page: number }).page;

      try {
        let res = redis
          ? await cache.fetch(
              redis as Redis,
              `hianime:recently-updated:${page}`,
              async () => await hianime.fetchRecentlyUpdated(page),
              REDIS_TTL,
            )
          : await hianime.fetchRecentlyUpdated(page);

        reply.status(200).send(res);
      } catch (err) {
        reply
          .status(500)
          .send({ message: 'Something went wrong. Contact developer for help.' });
      }
    },
  );

  fastify.get('/recently-added', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `hianime:recently-added:${page}`,
            async () => await hianime.fetchRecentlyAdded(page),
            REDIS_TTL,
          )
        : await hianime.fetchRecentlyAdded(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/top-upcoming', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `hianime:top-upcoming:${page}`,
            async () => await hianime.fetchTopUpcoming(page),
            REDIS_TTL,
          )
        : await hianime.fetchTopUpcoming(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/studio/:studio', async (request: FastifyRequest, reply: FastifyReply) => {
    const studio = (request.params as { studio: string }).studio;
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `hianime:studio:${studio}:${page}`,
            async () => await hianime.fetchStudio(studio, page),
            REDIS_TTL,
          )
        : await hianime.fetchStudio(studio, page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/subbed-anime', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `hianime:subbed:${page}`,
            async () => await hianime.fetchSubbedAnime(page),
            REDIS_TTL,
          )
        : await hianime.fetchSubbedAnime(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/dubbed-anime', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `hianime:dubbed:${page}`,
            async () => await hianime.fetchDubbedAnime(page),
            REDIS_TTL,
          )
        : await hianime.fetchDubbedAnime(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/movie', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `hianime:movie:${page}`,
            async () => await hianime.fetchMovie(page),
            REDIS_TTL,
          )
        : await hianime.fetchMovie(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/tv', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `hianime:tv:${page}`,
            async () => await hianime.fetchTV(page),
            REDIS_TTL,
          )
        : await hianime.fetchTV(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/ova', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `hianime:ova:${page}`,
            async () => await hianime.fetchOVA(page),
            REDIS_TTL,
          )
        : await hianime.fetchOVA(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/ona', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `hianime:ona:${page}`,
            async () => await hianime.fetchONA(page),
            REDIS_TTL,
          )
        : await hianime.fetchONA(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/special', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `hianime:special:${page}`,
            async () => await hianime.fetchSpecial(page),
            REDIS_TTL,
          )
        : await hianime.fetchSpecial(page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  fastify.get('/genre/:genre', async (request: FastifyRequest, reply: FastifyReply) => {
    const genre = (request.params as { genre: string }).genre;
    const page = (request.query as { page: number }).page;

    try {
      let res = redis
        ? await cache.fetch(
            redis as Redis,
            `hianime:genre:${genre}:${page}`,
            async () => await hianime.genreSearch(genre, page),
            REDIS_TTL,
          )
        : await hianime.genreSearch(genre, page);

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Contact developer for help.' });
    }
  });

  const fetchEpisodeSources = async (animeEpisodeId: string, episodeId: string, raw : Boolean, category : string): Promise<any> => {    
    try {
      const ANIWATCH_API = process.env.ANIWATCH_API;
      var response = null;
      if (!raw) {
        if ( category.includes("both") ) 
        {
          console.log("category.raw: ", category);            
          category = category.replace(
            "both",
            "sub"            
          );  
          console.log("category.fix: ", category);
        }        
        const urlServers = `${ANIWATCH_API}/api/v2/hianime/episode/servers?animeEpisodeId=${animeEpisodeId}?ep=${episodeId}`;
        const servers = await axios.get(urlServers);        
        console.log("response.data: ", servers.data);             
        if (servers.data != null && servers.data.data != null && servers.data.data[category] && servers.data.data[category].length > 0 ) {                
          for (let i = 0; i < servers.data.data[category].length; i++) 
          {
            const element = servers.data.data[category][i];
            if(element.serverName != null && element.serverName != "")
            {
              var url = `${ANIWATCH_API}/api/v2/hianime/episode/sources?animeEpisodeId=${animeEpisodeId}?ep=${episodeId}&server=${element.serverName}&category=${category}`;
              console.log("axios.url: ", url);
              response = await axios.get(url);
              console.log("axios.response: ", response.data);
              if (response.data.success && response.data.data != null && response.data.data.sources != null && response.data.data.sources.length > 0)     
                break;                              
            }                    
          }          
        }
      }else{
        // Crear la URL con los parámetros necesarios
        const url = `${ANIWATCH_API}/api/v2/hianime/episode/sources?animeEpisodeId=${animeEpisodeId}?ep=${episodeId}&category=raw`;
        // Hacer una solicitud GET a la URL
        response = await axios.get(url);
      }
  
      // Verificar si la respuesta es nula
      if (response == null) 
        return null;            

      // Accedemos a response.data.data correctamente
      const data = response.data.data;

      // Verificar si las claves existen y asignar valores predeterminados
      const sources = Array.isArray(data.sources) ? data.sources : [];
      const subtitles = Array.isArray(data.tracks) ? data.tracks : [];
      const introData = data.intro || {};  // Si intro existe, lo usamos
      const outroData = data.outro || {};  // Lo mismo con outro    

      // Extraer los parámetros de cada objeto en `sources`
      const sourcesDetails = sources.map((source: any) => ({
        url: source.url,  // Extraemos la URL
        type: source.type,  // Tipo de fuente (puede ser 'hls', etc.)
        quality: "AUTO",  // Calidad de la fuente
        isM3U8: true  // Si es un archivo M3U8
      }));

      // Extraer los parámetros de cada objeto en `subtitles`
      const subtitleDetails = subtitles
        .filter((subtitle: any) => subtitle.label)  // Filtra para incluir solo los elementos con `label` definido
        .map((subtitle: any) => ({
          url: subtitle.file,  // Archivo de subtítulo
          lang: subtitle.label.replace("CR_", "")   // Idioma del subtítulo (puede ser 'English', 'Spanish', etc.)
        }));

      // Crear el objeto final con todos los detalles extraídos
      const obj = {
        sources: sourcesDetails,  // Todos los detalles de las fuentes
        subtitles: subtitleDetails,  // Todos los detalles de los subtítulos
        intro: introData,  // URL de la intro
        outro: outroData,  // URL del outro
      };

      return obj;  // Retornar el objeto con todos los detalles
    } catch (error) {
      console.error("Error (fetchEpisodeSources):", error);
      return null;
    }
  };

};

export default routes;
