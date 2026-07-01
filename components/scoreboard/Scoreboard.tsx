import React, { useMemo } from 'react';
import { Toaster } from 'react-hot-toast';

type ScoreboardKeyword = {
   keyword: string,
   position: number,
   device: string,
   url: string,
}

type ScoreboardPage = {
   url: string,
   pathClean: string,
   page_title?: string,
   page_views: number,
   unique_visitors?: number,
   bounce_rate?: number,
   avg_duration?: number,
   keywords: ScoreboardKeyword[],
}

type ContentGapPage = {
   url: string,
   pathClean: string,
   page_title?: string,
   page_views: number,
   unique_visitors?: number,
   bounce_rate?: number,
   avg_duration?: number,
}

type UnmatchedKeyword = ScoreboardKeyword & { target_page: string }

export type ScoreboardData = {
   scoreboard?: ScoreboardPage[],
   pagesWithTrafficNoKeywords?: ContentGapPage[],
   keywordsWithNoMatchingPage?: UnmatchedKeyword[],
}

type ScoreboardProps = {
   domain: DomainType | null,
   data: ScoreboardData,
   isLoading: boolean,
}

// Aggregate UTM/query variants for display: group scoreboard rows by pathClean,
// summing page_views and unique_visitors and merging keywords, so "/" and
// "/?utm_medium=redirect" appear as one "/" row.
const aggregateByPath = (pages: ScoreboardPage[]): ScoreboardPage[] => {
   const byPath = new Map<string, ScoreboardPage>();
   pages.forEach((page) => {
      const existing = byPath.get(page.pathClean);
      if (!existing) {
         byPath.set(page.pathClean, {
            ...page,
            keywords: [...page.keywords],
         });
      } else {
         existing.page_views += page.page_views;
         // unique_visitors is optional (not every analytics provider reports it).
         if (typeof page.unique_visitors === 'number') {
            existing.unique_visitors = (existing.unique_visitors || 0) + page.unique_visitors;
         }
         // Merge keywords, de-duplicating by keyword + device.
         const seen = new Set(existing.keywords.map((k) => `${k.keyword}|${k.device}`));
         page.keywords.forEach((k) => {
            const key = `${k.keyword}|${k.device}`;
            if (!seen.has(key)) {
               seen.add(key);
               existing.keywords.push(k);
            }
         });
      }
   });
   return Array.from(byPath.values()).sort((a, b) => b.page_views - a.page_views);
};

const rankLabel = (position: number): string => (position > 0 ? `#${position}` : 'Not ranked');

const Scoreboard = ({ data, isLoading = true, domain }: ScoreboardProps) => {
   const scoreboard = useMemo(() => aggregateByPath(data?.scoreboard || []), [data?.scoreboard]);
   const contentGaps = data?.pagesWithTrafficNoKeywords || [];
   const unmatchedKeywords = data?.keywordsWithNoMatchingPage || [];

   const pageLink = (path: string): string => {
      const base = domain?.domain || '';
      const clean = path.startsWith('/') ? path : `/${path}`;
      return `https://${base}${clean === '/' ? '' : clean}`;
   };

   const badgeStyle = 'inline-block px-2 py-1 mr-2 mb-1 rounded bg-[#F8F9FF] border border-[#e9ebff] text-xs text-gray-700';
   const rankStyle = 'ml-1 font-semibold';

   return (
      <div>
         <div className='domKeywords flex flex-col bg-[white] rounded-md text-sm border mb-5'>
            <div className='domKeywords_filters py-4 px-6 flex flex-col justify-between
            text-sm text-gray-500 font-semibold border-b-[1px] lg:flex-row lg:items-center'>
               <span className='text-gray-700'>Page Scoreboard</span>
               <span className='text-xs font-normal mt-2 lg:mt-0'>Traffic, tracked keywords and live rank per page (Last 30 Days)</span>
            </div>

            <div className='domkeywordsTable styled-scrollbar w-full overflow-auto min-h-[40vh]'>
               <div className='lg:min-w-[800px]'>
                  <div className={`domKeywords_head hidden lg:flex p-3 px-6 bg-[#FCFCFF]
                     text-gray-600 justify-between items-center font-semibold border-y`}>
                     <span className='flex-1 basis-60 w-auto'>Page</span>
                     <span className='flex-1 text-center'>Page Views</span>
                     <span className='flex-1 text-center'>Unique Visitors</span>
                     <span className='flex-1 text-center'>Bounce Rate</span>
                     <span className='flex-[2] text-center'>Keywords</span>
                  </div>

                  <div className='domKeywords_keywords border-gray-200 min-h-[20vh] relative'>
                     {!isLoading && scoreboard.length === 0 && (
                        <p className='p-9 pt-[8%] text-center text-gray-500'>
                           No pages with both traffic and tracked keywords yet.
                        </p>
                     )}
                     {isLoading && (
                        <p className='p-9 pt-[8%] text-center text-gray-500'>Loading Scoreboard...</p>
                     )}
                     {!isLoading && scoreboard.map((page) => (
                        <div
                        key={page.pathClean}
                        className='flex flex-col p-4 px-6 border-b lg:flex-row lg:justify-between lg:items-center'>
                           <span className='flex-1 basis-60 w-auto mb-2 lg:mb-0'>
                              <a
                              href={pageLink(page.pathClean)}
                              target='_blank'
                              rel='noreferrer'
                              className='text-indigo-600 font-semibold break-all hover:underline'>
                                 {page.pathClean}
                              </a>
                              {page.page_title && (
                                 <span className='block text-xs text-gray-400 mt-1'>{page.page_title}</span>
                              )}
                           </span>
                           <span className='flex-1 text-left lg:text-center'>
                              <span className='lg:hidden text-gray-400 mr-2'>Page Views:</span>
                              {page.page_views.toLocaleString()}
                           </span>
                           <span className='flex-1 text-left lg:text-center'>
                              <span className='lg:hidden text-gray-400 mr-2'>Unique Visitors:</span>
                              {typeof page.unique_visitors === 'number' ? page.unique_visitors.toLocaleString() : 'n/a'}
                           </span>
                           <span className='flex-1 text-left lg:text-center'>
                              <span className='lg:hidden text-gray-400 mr-2'>Bounce Rate:</span>
                              {typeof page.bounce_rate === 'number' ? `${Math.round(page.bounce_rate)}%` : 'n/a'}
                           </span>
                           <span className='flex-[2] flex flex-wrap mt-2 lg:mt-0 lg:justify-center'>
                              {page.keywords.length === 0 && <span className='text-gray-400 text-xs'>None</span>}
                              {page.keywords.map((kw) => (
                                 <span key={`${kw.keyword}-${kw.device}`} className={badgeStyle}>
                                    {kw.keyword}
                                    <span className={`${rankStyle} ${kw.position > 0 ? 'text-indigo-600' : 'text-gray-400'}`}>
                                       {rankLabel(kw.position)}
                                    </span>
                                 </span>
                              ))}
                           </span>
                        </div>
                     ))}
                  </div>
               </div>
            </div>
         </div>

         <div className='flex flex-col gap-5 lg:flex-row'>
            <div className='flex-1 bg-[white] rounded-md text-sm border'>
               <div className='py-3 px-5 border-b font-semibold text-gray-600 text-xs uppercase tracking-wide'>
                  Pages with traffic but no tracked keyword
               </div>
               <div className='styled-scrollbar max-h-[40vh] overflow-auto'>
                  {contentGaps.length === 0 && (
                     <p className='p-5 text-center text-gray-400 text-xs'>Nothing here.</p>
                  )}
                  {contentGaps.map((page) => (
                     <div key={page.pathClean} className='flex justify-between items-center p-3 px-5 border-b last:border-b-0'>
                        <a
                        href={pageLink(page.pathClean)}
                        target='_blank'
                        rel='noreferrer'
                        className='text-indigo-600 break-all hover:underline mr-3'>
                           {page.pathClean}
                        </a>
                        <span className='text-gray-500 text-xs whitespace-nowrap'>{page.page_views.toLocaleString()} views</span>
                     </div>
                  ))}
               </div>
            </div>

            <div className='flex-1 bg-[white] rounded-md text-sm border'>
               <div className='py-3 px-5 border-b font-semibold text-gray-600 text-xs uppercase tracking-wide'>
                  Tracked keywords with no traffic yet
               </div>
               <div className='styled-scrollbar max-h-[40vh] overflow-auto'>
                  {unmatchedKeywords.length === 0 && (
                     <p className='p-5 text-center text-gray-400 text-xs'>Nothing here.</p>
                  )}
                  {unmatchedKeywords.map((kw) => (
                     <div key={`${kw.keyword}-${kw.device}`} className='flex justify-between items-center p-3 px-5 border-b last:border-b-0'>
                        <span className='mr-3'>
                           <span className='text-gray-700'>{kw.keyword}</span>
                           {kw.target_page && <span className='block text-xs text-gray-400'>{kw.target_page}</span>}
                        </span>
                        <span className={`text-xs whitespace-nowrap ${kw.position > 0 ? 'text-indigo-600' : 'text-gray-400'}`}>
                           {rankLabel(kw.position)}
                        </span>
                     </div>
                  ))}
               </div>
            </div>
         </div>

         <Toaster position='bottom-center' containerClassName="react_toaster" />
      </div>
   );
};

export default Scoreboard;
