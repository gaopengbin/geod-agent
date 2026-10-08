import {createPaymentLedgerCandidate} from '../../payment-ledger-candidate.mjs';
const ledger=createPaymentLedgerCandidate(process.argv[2],{loadGeneration:()=>null,welcomeCredit:{policyId:'quota-v1',creditNanoCny:'20000000000',maxRecipients:100}});
try{process.send(ledger.grantWelcome(process.argv[3]));}finally{ledger.close();}
