/* eslint-disable @next/next/no-img-element */
import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import Icon from './Icon';

type SidebarProps = {
   domains: DomainType[],
   showAddModal: Function
}

const Sidebar = ({ domains, showAddModal } : SidebarProps) => {
   const router = useRouter();

   return (
      <div className="sidebar pt-44 w-1/5 hidden lg:block" data-testid="sidebar">
         <h3 className="py-7 text-base font-bold text-zinc-800">
            s33k<span className=' relative top-[3px] ml-[2px]'><Icon type="logo" size={7} color="#3ED63A" /></span>
         </h3>
         <div className="sidebar_menu max-h-96 overflow-auto styled-scrollbar">
            <ul className=' font-medium text-sm'>
               {domains.map((d) => <li
                                 key={d.domain}
                                 className={'my-2.5 leading-10'}>
                                    <Link href={`/domain/${d.slug}`} passHref={true}>
                                       <a className={`block cursor-pointer px-4 text-ellipsis max-w-[215px] overflow-hidden whitespace-nowrap rounded
                                        rounded-r-none ${((`/domain/${d.slug}` === router.asPath || `/domain/console/${d.slug}` === router.asPath
                                        || `/domain/insight/${d.slug}` === router.asPath || `/domain/ideas/${d.slug}` === router.asPath)
                                        ? 'bg-white text-zinc-800 border border-r-0' : 'text-zinc-500')}`}>
                                          <img
                                          className={' inline-block mr-1'}
                                          src={`https://www.google.com/s2/favicons?domain=${d.domain}&sz=16`} alt={d.domain}
                                          />
                                          {d.domain}
                                       </a>
                                    </Link>
                                 </li>)
               }
            </ul>
         </div>
         <div className='sidebar_add border-t font-semibold text-sm text-center mt-6 w-[80%] ml-3 text-zinc-500'>
            <button data-testid="add_domain" onClick={() => showAddModal(true)} className='p-4 hover:text-blue-600'>+ Add Domain</button>
         </div>
    </div>
   );
 };

 export default Sidebar;
