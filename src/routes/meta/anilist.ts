import { Redis } from 'ioredis';
import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { ANIME, META, PROVIDERS_LIST } from '@consumet/extensions';
import { Genres, SubOrSub } from '@consumet/extensions/dist/models';
import Anilist from '@consumet/extensions/dist/providers/meta/anilist';
import { StreamingServers } from '@consumet/extensions/dist/models';

import cache from '../../utils/cache';
import { redis } from '../../main';
import NineAnime from '@consumet/extensions/dist/providers/anime/9anime';
import Zoro from '@consumet/extensions/dist/providers/anime/zoro';

const anilist = new META.Anilist();
const zoro = new ANIME.Zoro();

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  fastify.get('/', (_, rp) => {
    rp.status(200).send({
      intro:
        "Welcome to the anilist provider: check out the provider's website @ https://anilist.co/",
      routes: ['/:query', '/info/:id', '/watch/:episodeId'],
      documentation: 'https://docs.consumet.org/#tag/anilist',
    });
  });

  fastify.get('/:query', async (request: FastifyRequest, reply: FastifyReply) => {
    const anilist = generateAnilistMeta();

    const query = (request.params as { query: string }).query;

    const page = (request.query as { page: number }).page;
    const perPage = (request.query as { perPage: number }).perPage;

    const res = await anilist.search(query, page, perPage);

    reply.status(200).send(res);
  });

  fastify.get(
    '/advanced-search',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = (request.query as { query: string }).query;
      const page = (request.query as { page: number }).page;
      const perPage = (request.query as { perPage: number }).perPage;
      const type = (request.query as { type: string }).type;
      let genres = (request.query as { genres: string | string[] }).genres;
      const id = (request.query as { id: string }).id;
      const format = (request.query as { format: string }).format;
      let sort = (request.query as { sort: string | string[] }).sort;
      const status = (request.query as { status: string }).status;
      const year = (request.query as { year: number }).year;
      const season = (request.query as { season: string }).season;

      const anilist = generateAnilistMeta();

      if (genres) {
        JSON.parse(genres as string).forEach((genre: string) => {
          if (!Object.values(Genres).includes(genre as Genres)) {
            return reply.status(400).send({ message: `${genre} is not a valid genre` });
          }
        });

        genres = JSON.parse(genres as string);
      }

      if (sort) sort = JSON.parse(sort as string);

      if (season)
        if (!['WINTER', 'SPRING', 'SUMMER', 'FALL'].includes(season))
          return reply.status(400).send({ message: `${season} is not a valid season` });

      const res = await anilist.advancedSearch(
        query,
        type,
        page,
        perPage,
        format,
        sort as string[],
        genres as string[],
        id,
        year,
        status,
        season,
      );

      reply.status(200).send(res);
    },
  );

  fastify.get('/trending', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;
    const perPage = (request.query as { perPage: number }).perPage;

    const anilist = generateAnilistMeta();

    redis
      ? reply
        .status(200)
        .send(
          await cache.fetch(
            redis as Redis,
            `anilist:trending;${page};${perPage}`,
            async () => await anilist.fetchTrendingAnime(page, perPage),
            60 * 60,
          ),
        )
      : reply.status(200).send(await anilist.fetchTrendingAnime(page, perPage));
  });

  fastify.get('/popular', async (request: FastifyRequest, reply: FastifyReply) => {
    const page = (request.query as { page: number }).page;
    const perPage = (request.query as { perPage: number }).perPage;

    const anilist = generateAnilistMeta();

    redis
      ? reply
        .status(200)
        .send(
          await cache.fetch(
            redis as Redis,
            `anilist:popular;${page};${perPage}`,
            async () => await anilist.fetchPopularAnime(page, perPage),
            60 * 60,
          ),
        )
      : reply.status(200).send(await anilist.fetchPopularAnime(page, perPage));
  });

  fastify.get(
    '/airing-schedule',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const page = (request.query as { page: number }).page;
      const perPage = (request.query as { perPage: number }).perPage;
      const weekStart = (request.query as { weekStart: number | string }).weekStart;
      const weekEnd = (request.query as { weekEnd: number | string }).weekEnd;
      const notYetAired = (request.query as { notYetAired: boolean }).notYetAired;

      const anilist = generateAnilistMeta();
      const _weekStart = Math.ceil(Date.now() / 1000);

      const res = await anilist.fetchAiringSchedule(
        page ?? 1,
        perPage ?? 20,
        weekStart ?? _weekStart,
        weekEnd ?? _weekStart + 604800,
        notYetAired ?? true,
      );

      reply.status(200).send(res);
    },
  );

  fastify.get('/genre', async (request: FastifyRequest, reply: FastifyReply) => {
    const genres = (request.query as { genres: string }).genres;
    const page = (request.query as { page: number }).page;
    const perPage = (request.query as { perPage: number }).perPage;

    const anilist = generateAnilistMeta();

    if (typeof genres === 'undefined')
      return reply.status(400).send({ message: 'genres is required' });

    JSON.parse(genres).forEach((genre: string) => {
      if (!Object.values(Genres).includes(genre as Genres)) {
        return reply.status(400).send({ message: `${genre} is not a valid genre` });
      }
    });

    const res = await anilist.fetchAnimeGenres(JSON.parse(genres), page, perPage);

    reply.status(200).send(res);
  });

  fastify.get(
    '/recent-episodes',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const provider = (request.query as { provider: 'zoro' }).provider;
      const page = (request.query as { page: number }).page;
      const perPage = (request.query as { perPage: number }).perPage;

      const anilist = generateAnilistMeta(provider);

      const res = await anilist.fetchRecentEpisodes(provider, page, perPage);

      reply.status(200).send(res);
    },
  ),
    fastify.get('/random-anime', async (request: FastifyRequest, reply: FastifyReply) => {
      const anilist = generateAnilistMeta();

      const res = await anilist.fetchRandomAnime().catch((err) => {
        return reply.status(404).send({ message: 'Anime not found' });
      });
      reply.status(200).send(res);
    });

  fastify.get('/servers/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    const provider = (request.query as { provider?: string }).provider;

    let anilist = generateAnilistMeta(provider);

    const res = await anilist.fetchEpisodeServers(id);

    anilist = new META.Anilist();
    reply.status(200).send(res);
  });

  fastify.get('/episodes/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const today = new Date();
    const dayOfWeek = today.getDay();
    const id = (request.params as { id: string }).id;
    const provider = (request.query as { provider?: string }).provider;
    let fetchFiller = (request.query as { fetchFiller?: string | boolean }).fetchFiller;
    let dub = (request.query as { dub?: string | boolean }).dub;
    const locale = (request.query as { locale?: string }).locale;

    let anilist = generateAnilistMeta(provider);

    if (dub === 'true' || dub === '1') dub = true;
    else dub = false;

    if (fetchFiller === 'true' || fetchFiller === '1') fetchFiller = true;
    else fetchFiller = false;

    try {
      redis
        ? reply
          .status(200)
          .send(
            await cache.fetch(
              redis,
              `anilist:episodes;${id};${dub};${fetchFiller};${anilist.provider.name.toLowerCase()}`,
              async () =>
                anilist.fetchEpisodesListById(
                  id,
                  dub as boolean,
                  fetchFiller as boolean,
                ),
              dayOfWeek === 0 || dayOfWeek === 6 ? 60 * 120 : (60 * 60) / 2,
            ),
          )
        : reply
          .status(200)
          .send(await anilist.fetchEpisodesListById(id, dub, fetchFiller as boolean));
    } catch (err) {
      return reply.status(404).send({ message: 'Anime not found' });
    }
  });

  // anilist info without episodes
  fastify.get('/data/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;

    const anilist = generateAnilistMeta();
    const res = await anilist.fetchAnilistInfoById(id);

    reply.status(200).send(res);
  });

  // anilist info with episodes
  fastify.get('/info/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;
    const today = new Date();
    const dayOfWeek = today.getDay();
    var provider = (request.query as { provider?: string }).provider;
    let fetchFiller = (request.query as { fetchFiller?: string | boolean }).fetchFiller;
    let isDub = (request.query as { dub?: string | boolean }).dub;
    const locale = (request.query as { locale?: string }).locale;

    if (provider == undefined) {
      provider = "zoro"; 
    }

    let anilist = generateAnilistMeta(provider);

    console.log("\n- provider: ", provider);

    if (isDub === 'true' || isDub === '1') isDub = true;
    else isDub = false;

    if (fetchFiller === 'true' || fetchFiller === '1') fetchFiller = true;
    else fetchFiller = false;

    try {
      const fetchInfo = () => anilist.fetchAnimeInfo(id, isDub as boolean, fetchFiller as boolean);
      if (redis) {
        const data = await cache.fetch(
          redis,
          `anilist:info;${id};${isDub};${fetchFiller};${anilist.provider.name.toLowerCase()}`,
          fetchInfo, 
          dayOfWeek === 0 || dayOfWeek === 6 ? 60 * 120 : (60 * 60) / 2
        );
        if ( provider != undefined && provider == "zoro" ) {
          if (data.episodes == null || data.episodes.length === 0 || data.episodes.length != data.currentEpisode) 
          {
            var infoZoro = await processAnimeData(data, zoro);
            if ( infoZoro.length > 0) 
            {
              data.episodes = [];
              data.episodes = infoZoro;
            }
          }        
        } 

        if ( provider != undefined && provider == "zoro" ) {
          if (data && Array.isArray(data.episodes)) {
            data.episodes = data.episodes.map((episode) => ({
                ...episode,
                id: episode.id.endsWith("$both") ? episode.id : `${episode.id}$both`
            }));
          }
        }
        
        reply.status(200).send(data);
      } else {
        const data = await fetchInfo();        
        if ( provider != undefined && provider == "zoro" ) {
          if (data.episodes == null || data.episodes.length === 0 || data.episodes.length != data.currentEpisode) 
          {
            var infoZoro = await processAnimeData(data, zoro);
            if ( infoZoro.length > 0) 
            {
              data.episodes = [];
              data.episodes = infoZoro;
            }
          }        
        }  
        
        if ( provider != undefined && provider == "zoro" ) {
          if (data && Array.isArray(data.episodes)) {
            data.episodes = data.episodes.map((episode) => ({
                ...episode,
                id: episode.id.endsWith("$both") ? episode.id : `${episode.id}$both`
            }));
          }
        }

        reply.status(200).send(data);
      }
    } catch (err: any) {
      console.log("\n- Error (TRY #1): ", err);    
      let anilist2 = generateAnilistMeta();
      try {
        const fetchInfo = () => anilist2.fetchAnimeInfo(id, isDub as boolean, fetchFiller as boolean);
        if (redis) {
          const data = await cache.fetch(
            redis,
            `anilist:info;${id};${isDub};${fetchFiller};${anilist2.provider.name.toLowerCase()}`,
            fetchInfo, 
            dayOfWeek === 0 || dayOfWeek === 6 ? 60 * 120 : (60 * 60) / 2
          );
          if ( provider != undefined && provider == "zoro" ) {
            if (data.episodes == null || data.episodes.length === 0 || data.episodes.length != data.currentEpisode) 
            {
              var infoZoro = await processAnimeData(data, zoro);
              if ( infoZoro.length > 0) 
              {
                data.episodes = [];
                data.episodes = infoZoro;
              }
            }        
          } 
          reply.status(200).send(data);
        } else {
          const data = await fetchInfo();        
          if ( provider != undefined && provider == "zoro" ) {
            if (data.episodes == null || data.episodes.length === 0 || data.episodes.length != data.currentEpisode) 
            {
              var infoZoro = await processAnimeData(data, zoro);
              if ( infoZoro.length > 0) 
              {
                data.episodes = [];
                data.episodes = infoZoro;
              }
            }        
          }                
          reply.status(200).send(data);
        }
      } catch (err: any) {
        console.log("\n- Error (TRY #2): ", err);    
        reply.status(500).send({ message: err.message });
      }
    }
  });

  // Función asíncrona para procesar la información
  async function processAnimeData(data: any, zoro: any): Promise<any[]> {
    console.log("\n");
    console.log("\ndata.title: ", data.title);
    try {
      interface ITitle {
        romaji?: string;
        english?: string;
        native?: string;
        userPreferred?: string;
      }
      function isITitle(title: any): title is ITitle {
        return typeof title === 'object' && title !== null && 'romaji' in title;
      } 
      if (data && isITitle(data.title) && data.title.romaji) {
        const titleRomaji = data.title.romaji;
        const titleEnglish = data.title.english ? data.title.english : data.title.romaji;
        const zoroSearch = await zoro.search(
          trimQueryToMaxWords(titleRomaji)
        ); 
        if (zoroSearch != null && zoroSearch.results.length > 0) {
          var zoroId = zoroSearch.results[0].id;        
          for (const result of zoroSearch.results) 
          {
            var searchName = result.title.trim();
            var searchNameJapanese = result.japaneseTitle.trim();

            if ( searchName != null && searchName != undefined && searchName != "" ) {
              searchName = searchName.replace("½", "1/2");
            }
            if ( searchNameJapanese != null && searchNameJapanese != undefined && searchNameJapanese != "" ) {
              searchNameJapanese = searchNameJapanese.replace("½", "1/2");
            }

            console.log("\nsearchName: ", searchName);
            console.log("\nsearchNameJapanese: ", searchNameJapanese);
            console.log("\ndata.currentEpisode: ", data.currentEpisode);
            console.log("\nResult: ", result);

            if (((result.sub >= data.currentEpisode && data.currentEpisode <= result.sub + 1) /*|| result.episodes >= data.currentEpisode*/) 
              && (searchName.includes(titleRomaji) 
                || searchName.includes(titleEnglish) 
                || searchNameJapanese.includes(titleRomaji) 
                || searchNameJapanese.includes(titleEnglish)
              )
            ) {
                console.log("\nEntro en: ", result);
                zoroId = result.id;
            }
          }
          console.log("\nzoroId: ", zoroId);
          var zoroInfo = await zoro.fetchAnimeInfo(zoroId);
          console.log("\ndata.episodes: ", data.episodes);
          console.log("\n\nzoroInfo.episodes: ", zoroInfo.episodes);      
          console.log("\n");  
          if (zoroInfo.episodes && zoroInfo.episodes.length > 0) {
            return zoroInfo.episodes.map((item: any) => ({
              //id: replaceEpisodeNumber(item.id, item.number),
              id: item.id,              
              id_alt: item.id,              
              title: item.title,
              description: undefined,
              number: item.number,
              image: data.image,
              imageHash: "hash",
              url: item.url
            }));
          } 
        }else{
          console.log("\n- Else: ", data);   
        }
      } 
    }catch (error) {
      console.log("\n- Error: ", error);
    }
    return []; // Retorna un array vacío si no hay episodios o si el título no está disponible
  }

  function trimQueryToMaxWords(encodedQuery : string, maxWords = 15) {
    // Decodificar la cadena para trabajar con ella más fácilmente
    let decodedQuery = decodeURIComponent(encodedQuery);
    
    // Dividir la cadena en palabras basadas en espacios
    let words = decodedQuery.split(/\s+/);
    
    // Verificar si la cantidad de palabras excede el máximo permitido
    if (words.length > maxWords) {
      // Unir solo el número máximo permitido de palabras
      let trimmedWords = words.slice(0, maxWords).join(' ');
      // Codificar nuevamente la cadena antes de retornarla
      return encodeURIComponent(trimmedWords);
    }
    
    // Si no excede, retornar la cadena original
    return encodedQuery;
  }

  /*
  function replaceEpisodeNumber(input: string, newEpisodeNumber: number): string {
      // Partimos la cadena original en sus componentes
      const parts = input.split('$');
      // Partimos la segunda parte para acceder al número del episodio
      const episodeParts = parts[2].split('$');
      // Reemplazamos el número del episodio
      episodeParts[0] = `${newEpisodeNumber}`;
      // Reconstruimos la segunda parte
      parts[2] = episodeParts.join('$');
      // Reconstruimos la cadena completa
      return parts.join('$');
  }
  */

  // anilist character info
  fastify.get('/character/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;

    const anilist = generateAnilistMeta();
    const res = await anilist.fetchCharacterInfoById(id);

    reply.status(200).send(res);
  });

  fastify.get(
    '/watch/:episodeId',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const episodeId = (request.params as { episodeId: string }).episodeId;
      const provider = (request.query as { provider?: string }).provider;
      const server = (request.query as { server?: StreamingServers }).server;
      let isDub = (request.query as { dub?: string | boolean }).dub;

      if (server && !Object.values(StreamingServers).includes(server))
        return reply.status(400).send('Invalid server');

      if (isDub === 'true' || isDub === '1') isDub = true;
      else isDub = false;

      let anilist = generateAnilistMeta(provider);

      try {
        redis
          ? reply
            .status(200)
            .send(
              await cache.fetch(
                redis,
                `anilist:watch;${episodeId};${anilist.provider.name.toLowerCase()};${server};${isDub ? 'dub' : 'sub'}`,
                async () =>
                  provider === 'zoro' || provider === 'animekai'
                    ? await anilist.fetchEpisodeSources(
                      episodeId,
                      server,
                      isDub ? SubOrSub.DUB : SubOrSub.SUB,
                    )
                    : await anilist.fetchEpisodeSources(episodeId, server),
                600,
              ),
            )
          : reply
            .status(200)
            .send(
              provider === 'zoro' || provider === 'animekai'
                ? await anilist.fetchEpisodeSources(
                  episodeId,
                  server,
                  isDub ? SubOrSub.DUB : SubOrSub.SUB,
                )
                : await anilist.fetchEpisodeSources(episodeId, server),
            );

        anilist = new META.Anilist(undefined, {
          url: process.env.PROXY as string | string[],
        });
      } catch (err) {
        reply
          .status(500)
          .send({ message: 'Something went wrong. Contact developer for help.' });
      }
    },
  );

  //anilist staff info from character id (for example: voice actors)
  //http://127.0.0.1:3000/meta/anilist/staff/95095  (gives info of sukuna's voice actor (Junichi Suwabe) )
  fastify.get('/staff/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.params as { id: string }).id;

    const anilist = generateAnilistMeta();
    try {
      redis
        ? reply
          .status(200)
          .send(
            await cache.fetch(
              redis,
              `anilist:staff;${id}`,
              async () => await anilist.fetchStaffById(Number(id)),
              60 * 60,
            ),
          )
        : reply.status(200).send(await anilist.fetchStaffById(Number(id)));
    } catch (err: any) {
      reply.status(404).send({ message: err.message });
    }
  });
};

const generateAnilistMeta = (provider: string | undefined = undefined): Anilist => {
  if (typeof provider !== 'undefined') {
    let possibleProvider = PROVIDERS_LIST.ANIME.find(
      (p) => p.name.toLowerCase() === provider.toLocaleLowerCase(),
    );

    if (possibleProvider instanceof NineAnime) {
      possibleProvider = new ANIME.NineAnime(
        process.env?.NINE_ANIME_HELPER_URL,
        {
          url: process.env?.NINE_ANIME_PROXY as string,
        },
        process.env?.NINE_ANIME_HELPER_KEY as string,
      );
    }

    return new META.Anilist(possibleProvider, {
      url: process.env.PROXY as string | string[],
    });
  } else {
    // default provider is Zoro
    return new Anilist(new Zoro(), {
      url: process.env.PROXY as string | string[],
    });
  }
};

export default routes;
