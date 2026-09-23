import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2AToolApprovals } from '@/components/dashboard/agents/A2AToolApprovals';
const fetcher=vi.fn();const item={id:'approval',taskId:'child',toolName:'Bash',input:{command:'<script>not executable</script>'},inputHash:'a'.repeat(64),status:'pending',expiresAt:new Date(Date.now()+300_000).toISOString()};
const flush=async(ms=0)=>act(async()=>{await vi.advanceTimersByTimeAsync(ms);});
beforeEach(()=>{vi.useFakeTimers();vi.clearAllMocks();vi.stubGlobal('fetch',fetcher);vi.spyOn(document,'hidden','get').mockReturnValue(false);fetcher.mockResolvedValue(Response.json({approvals:[item]}));});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
const show=()=>render(<form onSubmit={e=>e.preventDefault()}><A2AToolApprovals base="/api/console" rootTaskId="root" taskId="child" /></form>);
describe('human native tool approval controls',()=>{
  it('renders exact parameters as inert text and never auto-approves',async()=>{show();await flush();expect(screen.getByText(/not executable/)).toBeInTheDocument();expect(document.querySelector('script')).toBeNull();expect(fetcher.mock.calls.every(([,init])=>!init.method)).toBe(true);});
  it.each(['Approve once','Deny'])('sends a parameter-bound decision only on %s',async(label)=>{show();await flush();fetcher.mockImplementation(async(_url,init)=>Response.json(init?.method==='POST'?{status:'approved'}:{approvals:[]}));fireEvent.click(screen.getByRole('button',{name:label}));await flush();const post=fetcher.mock.calls.find(([,init])=>init.method==='POST');expect(post).toBeDefined();expect(JSON.parse(post![1].body)).toEqual({rootTaskId:'root',taskId:'child',approvalId:'approval',inputHash:'a'.repeat(64),decision:label==='Deny'?'denied':'approved'});expect(screen.queryByText('Bash')).not.toBeInTheDocument();});
  it('clears parameter data after access revocation and stops polling',async()=>{show();await flush();fetcher.mockImplementation(async()=>Response.json({error:'revoked'},{status:403}));await flush(2500);expect(screen.queryByText('Bash')).not.toBeInTheDocument();const count=fetcher.mock.calls.length;await flush(60_000);expect(fetcher).toHaveBeenCalledTimes(count);});
  it('does not automatically retry an uncertain decision',async()=>{show();await flush();fetcher.mockRejectedValue(new Error('disconnected'));fireEvent.click(screen.getByRole('button',{name:'Approve once'}));await flush();await flush(60_000);expect(fetcher.mock.calls.filter(([,init])=>init.method==='POST')).toHaveLength(1);});
  it('aborts an outstanding decision on unmount',async()=>{const mounted=show();await flush();fetcher.mockImplementation(()=>new Promise(()=>{}));fireEvent.click(screen.getByRole('button',{name:'Deny'}));await flush();const signal=fetcher.mock.lastCall![1].signal as AbortSignal;mounted.unmount();expect(signal.aborted).toBe(true);});
});
