import { DATA_DOWNLOAD_TOOLS } from './data-download-tools.mjs';
import { MAINTENANCE_TOOLS } from './maintenance-tools.mjs';
import { DATA_CONNECTION_TOOLS } from './data-connection-tools.mjs';
import { AGENT_TASK_TOOLS } from './agent-task-tools.mjs';
import { USER_INPUT_TOOLS } from './user-input-tools.mjs';
export const RANGE_TOOLS = [
  ...USER_INPUT_TOOLS,
  ...AGENT_TASK_TOOLS,
  ...DATA_DOWNLOAD_TOOLS,
  ...MAINTENANCE_TOOLS,
  ...DATA_CONNECTION_TOOLS,
  {type:'function',function:{name:'schedules_cancel_run',description:'Cancel one unfinished scheduled occurrence when the user asks, including a pending plan or a running download. Get runId from schedules_list. Future recurring triggers stay enabled; separately pause the schedule if requested.',parameters:{type:'object',properties:{runId:{type:'string'}},required:['runId'],additionalProperties:false}}},
  {type:'function',function:{name:'schedules_create',description:'Create a durable local imagery schedule from an actual plan. Only when user asks to run later or repeat. Each occurrence creates a fresh plan and output folder; does not execute immediately. nextRunAt must be an ISO-8601 timestamp with timezone. repeatSeconds omitted = once; interval is elapsed seconds. App must be running; missed intervals coalesce to one run on reopening. fullAccess executes; confirmEach creates a pending plan in the task panel. maxRetries covers transient network failures, not permanent errors. Does not schedule arbitrary AI prompts.',parameters:{type:'object',properties:{planId:{type:'string'},name:{type:'string'},nextRunAt:{type:'string'},repeatSeconds:{type:'integer',minimum:60,maximum:31536000},maxRetries:{type:'integer',minimum:0,maximum:3}},required:['planId','name','nextRunAt'],additionalProperties:false}}},
  {type:'function',function:{name:'schedules_list',description:'Read this conversation’s local imagery schedules and actual persisted run records, including planId/jobId and retry errors. Do not infer that a future task has executed.',parameters:{type:'object',properties:{},additionalProperties:false}}},
  {type:'function',function:{name:'schedules_set_enabled',description:'Pause or resume future occurrences of an existing local imagery schedule when the user requests it. Does not cancel a current download; use jobs_cancel for an active job. Completed one-time schedules require a new nextRunAt to enable again.',parameters:{type:'object',properties:{scheduleId:{type:'string'},enabled:{type:'boolean'},nextRunAt:{type:'string'}},required:['scheduleId','enabled'],additionalProperties:false}}},
  { type: 'function', function: { name: 'boundaries_list', description: 'List saved input ranges for this conversation, with stable boundaryId, name, bounds, polygon count and merge inputs. Geometry stays on desktop. Reading or looking up another range does not replace existing records. Use an explicit boundaryId when planning a particular region.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'boundaries_combine', description: 'Combine saved ranges into one clipping region, preserving all polygons and holes. Returns a new boundaryId; original records stay available. Only use IDs returned in this conversation. Does not download.', parameters: { type: 'object', properties: { boundaryIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32 }, name: { type: 'string' } }, required: ['boundaryIds'], additionalProperties: false } } },
  { type: 'function', function: { name: 'plan_imagery_batch', description: 'Plan imagery for multiple saved ranges. mode merge creates one GeoTIFF clipped to the union; split creates a separate named plan/output folder per region. Requires actual boundaryIds from this conversation. Returns each plan and any per-region errors; never treat partial success as all completed. Native capacity limits apply. Does not start downloads: fullAccess may call jobs_start per plan when user requested execution; confirmEach waits for the plan controls.', parameters: { type: 'object', properties: { sourceId: { type: 'string' }, boundaryIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32 }, mode: { type: 'string', enum: ['merge', 'split'] }, name: { type: 'string' }, zoom: { type: 'integer' }, outputFormats: { type: 'array', items: { type: 'string', enum: ['geotiff', 'mbtiles'] }, minItems: 1 } }, required: ['sourceId', 'boundaryIds', 'mode', 'zoom', 'outputFormats'], additionalProperties: false } } },
];

export function withRangeTools(tools) {
  return [...tools, ...RANGE_TOOLS].map(tool => ['plan_imagery', 'plan_imagery_batch'].includes(tool.function.name) ? { ...tool, function: { ...tool.function,
    description: tool.function.description + ' Select zoom using exactly one of: zoom for one level, zoomLevels for explicit multiple levels, or paired zoomMin/zoomMax for an inclusive range. GeoTIFF uses bounded-memory streaming BigTIFF. Default to uncompressed GeoTIFF and no pyramid for fast export; select compression or pyramids only when the user requests them. Supply boundaryId to explicitly select one saved range; for multiple regions use plan_imagery_batch.',
    parameters: { ...tool.function.parameters,
      required: tool.function.parameters.required.filter(name => name !== 'zoom'),
      properties: { ...tool.function.parameters.properties,
        ...(tool.function.name === 'plan_imagery' ? { boundaryId: { type: 'string' } } : {}),
        zoomLevels: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 22 }, minItems: 1, maxItems: 23 },
        zoomMin: { type: 'integer', minimum: 0, maximum: 22 }, zoomMax: { type: 'integer', minimum: 0, maximum: 22 },
        overlaySourceIds: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Registered annotation source IDs in bottom-to-top order. Composites pixels into outputs; requires the same pixel size and available zooms. Authentication is resolved locally.' },
        outputFormats: { type: 'array', items: { type: 'string', enum: ['geotiff', 'mbtiles', 'png', 'jpeg', 'gpkg', 'tiles'] }, minItems: 1 },
        exportOptions: { type: 'object', properties: {
          targetCrs: {type:'string',description:'Explicit user-selected target EPSG CRS, or the saved conversation default. Never infer it. Ask with an interactive card when missing. GeoTIFF/PNG/JPEG can be reprojected by the optional raster conversion skill; non-native output images include world files. MBTiles/tile GeoPackage/raw tiles only support EPSG:3857.'},
          resampling: {type:'string',enum:['nearest','bilinear','cubic'],description:'Nearest by default preserves pixel values; state this in coordinate options. A user can request bilinear/cubic.'},
          compression: { type: 'string', enum: ['none', 'lzw', 'deflate'], default: 'none', description: 'Default none for fast export; only choose LZW or DEFLATE when the user requests compression.' }, buildPyramid: { type: 'boolean', default: false },
          generateSidecars: { type: 'boolean' }, jpegQuality: { type: 'integer', minimum: 1, maximum: 100 },
          elevationEncoding: { type: 'string', enum: ['terrarium'], description: 'Only for a Terrarium elevation source: produces one-band Float32 GeoTIFF in metres, NoData -9999. Requires outputFormats [geotiff] and no annotation overlays.' },
        }, additionalProperties: false },
      },
    },
  } } : ['source_configure','source_registration_prepare'].includes(tool.function.name) ? { ...tool, function: { ...tool.function, parameters: { ...tool.function.parameters,
    properties: { ...tool.function.parameters.properties, elevationEncoding: { type:'string',enum:['terrarium'],description:'Declare an actual Terrarium DEM source so planning automatically exports metre-valued Float32 GeoTIFF.' },
      subdomains: { type:'array',items:{type:'string'},maxItems:16,description:'Exact subdomain labels to rotate when urlTemplate contains {s}, e.g. ["0","1","2","3"].' },
      coordinateSystem: { type:'string',enum:['wgs84','gcj02'],description:'Source tile coordinate system. Declare gcj02 for actual GCJ-02 sources; native preview and download resample to WGS84. Do not guess based only on location.' },
    },
  } } } : tool);
}
