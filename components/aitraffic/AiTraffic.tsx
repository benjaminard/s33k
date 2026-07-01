import React, { useMemo } from 'react';
import { Toaster } from 'react-hot-toast';
import Icon from '../common/Icon';

type ReferralSource = {
   name: string,
   type: string,
   engine: string | null,
   isAI: boolean,
   page_views?: number,
   unique_visitors: number,
   utm_source?: string,
   utm_medium?: string,
   utm_campaign?: string,
}

type ByEngineRow = {
   engine: string,
   visitors: number,
}

export type AiTrafficData = {
   aiSources?: ReferralSource[],
   byEngine?: ByEngineRow[],
   totals?: {
      aiVisitors: number,
      allVisitors: number,
      aiSharePct: number,
   },
   allSources?: ReferralSource[],
   error?: string | null,
}

type AiTrafficProps = {
   domain: DomainType | null,
   data: AiTrafficData,
   isLoading: boolean,
}

const AiTraffic = ({ data, isLoading = true }: AiTrafficProps) => {
   const byEngine = useMemo(() => data?.byEngine || [], [data?.byEngine]);
   const allSources = useMemo(() => data?.allSources || [], [data?.allSources]);
   const totals = data?.totals || { aiVisitors: 0, allVisitors: 0, aiSharePct: 0 };
   const analyticsError = data?.error || null;

   const badgeStyle = 'inline-block px-2 py-1 ml-2 rounded bg-[#EEF2FF] border border-[#e9ebff] text-[11px] text-indigo-600 font-semibold';

   return (
      <div>
         {analyticsError && (
            <div className='mb-3 p-3 px-4 rounded-md bg-amber-50 border border-amber-200 text-amber-700 text-sm flex items-center'>
               <Icon type='error' size={16} color='#b45309' classes='mr-2' />
               Analytics not connected. AI referral data unavailable.
            </div>
         )}

         {/* Headline */}
         <div className='mb-5 p-6 bg-[white] rounded-md border'>
            {isLoading ? (
               <p className='text-gray-500'>Loading AI Traffic...</p>
            ) : (
               <>
                  <h2 className='text-lg font-bold text-gray-800'>
                     {totals.aiVisitors.toLocaleString()} visitor{totals.aiVisitors === 1 ? '' : 's'} from AI engines,
                     {' '}{totals.aiSharePct}% of referred traffic
                  </h2>
                  <p className='text-sm text-gray-500 mt-1'>
                     Measured from analytics referral data (Last 90 Days). Which AI engines are actually sending people to your site.
                  </p>
               </>
            )}
         </div>

         {/* By-engine table */}
         <div className='domKeywords flex flex-col bg-[white] rounded-md text-sm border mb-5'>
            <div className='domKeywords_filters py-4 px-6 flex flex-col justify-between
            text-sm text-gray-500 font-semibold border-b-[1px] lg:flex-row lg:items-center'>
               <span className='text-gray-700'>AI Engines</span>
               <span className='text-xs font-normal mt-2 lg:mt-0'>Visitors sent to your site, by engine (Last 90 Days)</span>
            </div>

            <div className='domkeywordsTable styled-scrollbar w-full overflow-auto'>
               <div className='lg:min-w-[600px]'>
                  <div className={`domKeywords_head hidden lg:flex p-3 px-6 bg-[#FCFCFF]
                     text-gray-600 justify-between items-center font-semibold border-y`}>
                     <span className='flex-1 basis-60 w-auto'>Engine</span>
                     <span className='flex-1 text-center'>Visitors</span>
                     <span className='flex-1 text-center'>Share</span>
                  </div>

                  <div className='domKeywords_keywords border-gray-200 min-h-[15vh] relative'>
                     {!isLoading && byEngine.length === 0 && (
                        <p className='p-9 pt-[6%] text-center text-gray-500'>
                           No AI engines have sent referral traffic yet.
                        </p>
                     )}
                     {isLoading && (
                        <p className='p-9 pt-[6%] text-center text-gray-500'>Loading AI Traffic...</p>
                     )}
                     {!isLoading && byEngine.map((row) => {
                        const share = totals.aiVisitors > 0
                           ? Math.round((row.visitors / totals.aiVisitors) * 1000) / 10
                           : 0;
                        return (
                           <div
                           key={row.engine}
                           className='flex flex-col p-4 px-6 border-b lg:flex-row lg:justify-between lg:items-center'>
                              <span className='flex-1 basis-60 w-auto mb-2 lg:mb-0 text-gray-700 font-semibold'>
                                 {row.engine}
                              </span>
                              <span className='flex-1 text-left lg:text-center'>
                                 <span className='lg:hidden text-gray-400 mr-2'>Visitors:</span>
                                 {row.visitors.toLocaleString()}
                              </span>
                              <span className='flex-1 text-left lg:text-center'>
                                 <span className='lg:hidden text-gray-400 mr-2'>Share:</span>
                                 {share}%
                              </span>
                           </div>
                        );
                     })}
                  </div>
               </div>
            </div>
         </div>

         {/* All referral sources, AI ones badged */}
         <div className='bg-[white] rounded-md text-sm border'>
            <div className='py-3 px-5 border-b font-semibold text-gray-600 text-xs uppercase tracking-wide'>
               All referral sources
            </div>
            <div className='styled-scrollbar max-h-[45vh] overflow-auto'>
               {!isLoading && allSources.length === 0 && (
                  <p className='p-5 text-center text-gray-400 text-xs'>Nothing here.</p>
               )}
               {isLoading && (
                  <p className='p-5 text-center text-gray-400 text-xs'>Loading...</p>
               )}
               {!isLoading && allSources.map((source, idx) => (
                  <div
                  key={`${source.name}-${idx}`}
                  className='flex justify-between items-center p-3 px-5 border-b last:border-b-0'>
                     <span className='mr-3 break-all'>
                        <span className='text-gray-700'>{source.name || '(direct / none)'}</span>
                        {source.isAI && (
                           <span className={badgeStyle}>
                              AI{source.engine && source.engine !== source.name ? ` · ${source.engine}` : ''}
                           </span>
                        )}
                     </span>
                     <span className='text-gray-500 text-xs whitespace-nowrap'>
                        {source.unique_visitors.toLocaleString()} visitor{source.unique_visitors === 1 ? '' : 's'}
                     </span>
                  </div>
               ))}
            </div>
         </div>

         <Toaster position='bottom-center' containerClassName="react_toaster" />
      </div>
   );
};

export default AiTraffic;
