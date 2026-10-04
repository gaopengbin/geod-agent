import {createPaymentLedgerCandidate} from '../../payment-ledger-candidate.mjs';
const ledger=createPaymentLedgerCandidate(process.argv[2],{loadGeneration:()=>null,welcomeCredit:{policyId:'welcome-v1',creditNanoCny:'20000000000'}});
try{process.send(ledger.grantWelcome('shared-account'));}finally{ledger.close();}
