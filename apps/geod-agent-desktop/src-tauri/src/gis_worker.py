"""GIS skill operations; heavy imports occur inside the requested capability."""
from pathlib import Path
import json, math, os

def workspace_file(raw, output=False):
    root=Path.cwd().resolve(); path=Path(raw); path=(root/path).resolve() if not path.is_absolute() else path.resolve()
    if not path.is_relative_to(root): raise ValueError('GIS path is outside workspace')
    if output:
        if path.exists() or not path.parent.is_dir(): raise ValueError('Choose a new file in an existing workspace directory')
    elif not path.is_file(): raise ValueError('Input file does not exist')
    return path

def vector_operation(name,args):
    import geopandas as gpd
    import pyogrio
    from shapely.geometry import box
    source=workspace_file(args['uri'])
    if name=='vector_info':
        layers=pyogrio.list_layers(source); info=pyogrio.read_info(source)
        return {'driver':info['driver'],'crs':info['crs'],'layer_count':len(layers),'feature_count':info['features'],
                'geometry_types':[info['geometry_type']],'fields':list(zip(info['fields'].tolist(),info['dtypes'].tolist())),
                'bounds':list(info['total_bounds']) if info.get('total_bounds') is not None else None}
    output=workspace_file(args['output'],True);frame=gpd.read_file(source,engine='pyogrio')
    if name=='vector_reproject':
        if args.get('src_crs'): frame=frame.set_crs(args['src_crs'],allow_override=True)
        if frame.crs is None: raise ValueError('Source coordinate system is required')
        frame=frame.to_crs(args['dst_crs'])
    elif name=='vector_clip':
        if bool(args.get('bounds'))==bool(args.get('mask')): raise ValueError('Choose either bounds or mask')
        mask=box(*args['bounds']) if args.get('bounds') else gpd.read_file(workspace_file(args['mask']),engine='pyogrio').to_crs(frame.crs)
        frame=gpd.clip(frame,mask)
    elif name=='vector_buffer':
        distance=float(args['distance'])
        if not math.isfinite(distance): raise ValueError('Buffer distance must be finite')
        frame.geometry=frame.geometry.buffer(distance,resolution=int(args.get('resolution') or 16))
    elif name=='vector_simplify':
        if args.get('method','douglas-peucker') not in ('douglas-peucker','douglas_peucker'): raise ValueError('This skill supports Douglas-Peucker simplification')
        tolerance=float(args['tolerance'])
        if not math.isfinite(tolerance) or tolerance<0: raise ValueError('Invalid simplification tolerance')
        frame.geometry=frame.geometry.simplify(tolerance,preserve_topology=args.get('preserve_topology',True))
    elif name!='vector_convert': raise ValueError('Unknown vector operation')
    options={}
    if args.get('driver'): options['driver']=args['driver']
    if args.get('encoding'): options['encoding']=args['encoding']
    frame.to_file(output,engine='pyogrio',**options)
    return {'feature_count':len(frame),'crs':str(frame.crs),'bounds':frame.total_bounds.tolist() if len(frame) else None,
            'output':str(output.relative_to(Path.cwd().resolve())),'size_bytes':output.stat().st_size}

def raster_operation(name,args):
    import numpy as np
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.shutil import copy as raster_copy
    from rasterio.warp import calculate_default_transform,reproject
    source=workspace_file(args['uri'])
    with rasterio.open(source) as dataset:
        if name=='raster_info': return {'driver':dataset.driver,'width':dataset.width,'height':dataset.height,'count':dataset.count,
            'crs':str(dataset.crs) if dataset.crs else None,'bounds':list(dataset.bounds),'dtypes':list(dataset.dtypes),
            'nodata':dataset.nodata,'resolution':list(dataset.res),'overviews':dataset.overviews(int(args.get('band') or 1))}
        if name=='raster_stats':
            params=args.get('params') or {}; bands=params.get('bands') or list(range(1,dataset.count+1)); result=[]
            if isinstance(bands,int): bands=[bands]
            for band in bands:
                count=0; total=0.; squares=0.; minimum=float('inf'); maximum=float('-inf')
                for _,window in dataset.block_windows(band):
                    data=dataset.read(band,window=window,masked=True).compressed().astype('float64'); data=data[np.isfinite(data)]
                    if data.size: count+=data.size;total+=data.sum();squares+=(data*data).sum();minimum=min(minimum,float(data.min()));maximum=max(maximum,float(data.max()))
                result.append({'band':band,'count':int(count),'min':minimum if count else None,'max':maximum if count else None,
                    'mean':float(total/count) if count else None,'std':float(math.sqrt(max(0,squares/count-(total/count)**2))) if count else None})
            return {'bands':result}
        output=workspace_file(args['output'],True)
        if name=='raster_convert':
            options=args.get('options') or {}; driver=options.get('driver') or ('COG' if options.get('cog') else 'GTiff'); creation={}
            for key in ('compress','compression','tiled','blockxsize','blockysize','blocksize','predictor','bigtiff'):
                if options.get(key) is not None: creation['compress' if key=='compression' else key]=options[key]
            if driver=='COG': creation.pop('tiled',None)
            raster_copy(dataset,output,driver=driver,**creation)
            overview=options.get('overview_levels') or options.get('overviews')
            if isinstance(overview,list) and overview and driver!='COG':
                with rasterio.open(output,'r+') as target: target.build_overviews(overview,Resampling.nearest)
        elif name=='raster_reproject':
            src_crs=args.get('src_crs') or dataset.crs
            if src_crs is None: raise ValueError('Source coordinate system is required')
            transform,width,height=calculate_default_transform(src_crs,args['dst_crs'],dataset.width,dataset.height,*dataset.bounds,resolution=args.get('resolution'))
            if args.get('bounds') is not None: raise ValueError('Use a separate clipping operation for custom raster bounds')
            if args.get('width') or args.get('height'):
                if not args.get('width') or not args.get('height'): raise ValueError('Both width and height are required')
                old_width,old_height=width,height;width,height=int(args['width']),int(args['height']);transform=transform*transform.scale(old_width/width,old_height/height)
            profile=dataset.profile.copy();profile.update(crs=args['dst_crs'],transform=transform,width=width,height=height)
            if args.get('nodata') is not None: profile['nodata']=args['nodata']
            with rasterio.open(output,'w',**profile) as target:
                for band in range(1,dataset.count+1): reproject(rasterio.band(dataset,band),rasterio.band(target,band),src_transform=dataset.transform,src_crs=src_crs,dst_transform=transform,dst_crs=args['dst_crs'],resampling=Resampling[args.get('resampling') or 'nearest'])
        else: raise ValueError('Unknown raster operation')
    return {'output':str(output.relative_to(Path.cwd().resolve())),'size_bytes':output.stat().st_size}

def gis_operation(name,args):
    if name.startswith('vector_'): return vector_operation(name,args)
    if name.startswith('raster_'): return raster_operation(name,args)
    raise ValueError('Unknown GIS operation')
