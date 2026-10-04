const string={type:'string'};
const tool=(name,description,properties={},required=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
export const DATA_CONNECTION_TOOLS=[
 tool('tiles3d_connections_list','List saved 3D service connections and whether their credentials are ready. Secret values are never returned. Use connectionId with data_download_plan.'),
 tool('tiles3d_connection_prepare','Prepare a 3D service connection on user request. direct uses a credential-free tileset URL; cesiumIon uses an assetId. If authentication or request headers are needed, the user enters values in the 3D connections panel; do not ask for tokens in chat or put them in tool arguments. requiredHeaders contains header names only, including Authorization or Referer when actually required. This creates configuration, not a download.',{name:string,kind:{type:'string',enum:['direct','cesiumIon']},tilesetUrl:string,assetId:{type:'integer',minimum:1},requiredHeaders:{type:'array',items:string,maxItems:16}},['name','kind']),
 tool('tiles3d_connection_test','Test a saved 3D service using credentials from the native secure store. Reports actual connection readiness; does not download the dataset.',{connectionId:string},['connectionId']),
];
