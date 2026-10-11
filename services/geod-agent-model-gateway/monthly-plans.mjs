// Proposed monthly tiers. This catalogue is preview data until explicitly
// adopted by a reviewed payment configuration; it never enables checkout.
export const monthlyPlanPolicy=Object.freeze({version:'geod-monthly-credit-v1',periodDays:30,autoRenew:false,creditExpires:false,tierDifference:'credits',refundPolicy:'manual-review'});
export const monthlyPlanDraft=Object.freeze([
 Object.freeze({id:'agent-month-light',name:'轻量月套餐',kind:'subscription',priceFen:1000,creditNanoCny:'10000000000',days:30}),
 Object.freeze({id:'agent-month-standard',name:'标准月套餐',kind:'subscription',priceFen:2000,creditNanoCny:'20000000000',days:30}),
 Object.freeze({id:'agent-month-pro',name:'进阶月套餐',kind:'subscription',priceFen:5000,creditNanoCny:'50000000000',days:30}),
]);
export const isMonthlyTier=product=>product?.kind==='subscription'&&product.id?.startsWith('agent-month-');
export const monthlyPlanPreview=Object.freeze({state:'draft',policy:monthlyPlanPolicy,products:monthlyPlanDraft});
