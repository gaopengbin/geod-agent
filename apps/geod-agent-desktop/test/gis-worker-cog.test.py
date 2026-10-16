"""Real raster regressions: explicit COG pyramids, layout, pixels and failures."""
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from osgeo_utils.samples.validate_cloud_optimized_geotiff import validate

spec=importlib.util.spec_from_file_location('gis_worker',Path(__file__).resolve().parents[1]/'src-tauri/src/gis_worker.py')
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)

class CogRegression(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.previous=Path.cwd();os.chdir(self.tmp.name)
        self.source=Path('source.tif');self.data=np.random.default_rng(42).integers(0,255,(3,577,643),dtype='uint8')
        with rasterio.open(self.source,'w',driver='GTiff',width=643,height=577,count=3,dtype='uint8',crs='EPSG:4326',transform=from_origin(116.38,39.93,.00001,.00001)) as target:
            target.write(self.data)
        self.original=hashlib.sha256(self.source.read_bytes()).hexdigest()
    def tearDown(self):
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(),self.original)
        self.assertFalse(list(Path('.').glob('.geod-raster-*')))
        os.chdir(self.previous);self.tmp.cleanup()
    def convert(self,name,**options):
        return worker.raster_operation('raster_convert',{'uri':str(self.source),'output':name,'options':options})
    def test_cog_explicit_levels_survive_valid_cloud_layout(self):
        result=self.convert('delivery.tif',driver='COG',compression='lzw',overviews=[2,4,8],overview_resampling='average')
        self.assertEqual(result['overviews_built'],[2,4,8]);self.assertEqual(result['layout'],'COG')
        with rasterio.open('delivery.tif') as target:
            np.testing.assert_array_equal(target.read(),self.data)
            self.assertEqual(target.overviews(1),[2,4,8]);self.assertEqual(str(target.crs),'EPSG:4326')
            # The overview content must use the requested average, not nearest.
            with rasterio.open(self.source) as source:
                expected=source.read(out_shape=(3,289,322),resampling=Resampling.average)
            actual=target.read(out_shape=(3,289,322),resampling=Resampling.nearest)
            np.testing.assert_array_equal(actual,expected)
        warnings,errors,_=validate('delivery.tif',check_tiled=True,full_check=True)
        self.assertEqual(errors,[]);self.assertEqual(warnings,[])
    def test_no_overviews_is_explicit_and_count_creation_option_is_honored(self):
        self.assertEqual(self.convert('none.tif',driver='COG',overviews=[])['overviews_built'],[])
        self.assertEqual(self.convert('count.tif',driver='COG',creation_options={'OVERVIEW_COUNT':3})['overviews_built'],[2,4,8])
        self.assertEqual(self.convert('alias.tif',cog=True,overview_levels=[2,4,8],creation_options={'OVERVIEW_COUNT':1})['overviews_built'],[2,4,8])
    def test_source_pyramid_is_not_silently_substituted(self):
        with rasterio.open(self.source,'r+') as target:target.build_overviews([2],Resampling.nearest)
        self.original=hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.assertEqual(self.convert('new.tif',driver='COG',overviews=[2,4,8])['overviews_built'],[2,4,8])
        self.assertEqual(self.convert('empty.tif',driver='COG',overviews=[])['overviews_built'],[])
    def test_geotiff_and_default_cog_keep_working(self):
        self.assertEqual(self.convert('gtiff.tif',driver='GTiff',overviews=[2,4,8])['overviews_built'],[2,4,8])
        self.assertEqual(self.convert('default.tif',driver='COG')['layout'],'COG')
    def test_invalid_options_leave_no_partial_output(self):
        for index,options in enumerate([{'overviews':[2,2]},{'overviews':[4,2]},{'overviews':[1]},{'overviews':[2.0]},{'overviews':'2,4'},{'overview_resampling':'invalid'},{'driver':'PNG','overviews':[2]},{'compression':'invalid'}]):
            with self.subTest(options=options):
                with self.assertRaises(Exception):self.convert(f'bad-{index}.tif',driver=options.pop('driver','COG'),**options)
                self.assertFalse(Path(f'bad-{index}.tif').exists())
    def test_existing_output_is_not_replaced(self):
        Path('existing.tif').write_bytes(b'protected')
        with self.assertRaises(ValueError):self.convert('existing.tif',driver='COG',overviews=[2,4,8])
        self.assertEqual(Path('existing.tif').read_bytes(),b'protected')
    def test_non_tiff_conversion_retains_georeferencing_sidecar(self):
        self.convert('delivery.png',driver='PNG')
        self.assertTrue(Path('delivery.png.aux.xml').exists())
        with rasterio.open('delivery.png') as target,rasterio.open(self.source) as source:
            self.assertEqual(target.crs,source.crs);self.assertEqual(target.transform,source.transform)
            np.testing.assert_array_equal(target.read(),self.data)
    @unittest.skipUnless(os.name=='nt','Windows output ACL regression')
    def test_output_inherits_workspace_access_like_direct_output(self):
        import ctypes
        from ctypes import wintypes
        security=ctypes.WinDLL('advapi32',use_last_error=True)
        get=security.GetFileSecurityW
        get.argtypes=[wintypes.LPCWSTR,wintypes.DWORD,ctypes.c_void_p,wintypes.DWORD,ctypes.POINTER(wintypes.DWORD)]
        get.restype=wintypes.BOOL
        get_acl=security.GetSecurityDescriptorDacl
        get_acl.argtypes=[ctypes.c_void_p,ctypes.POINTER(wintypes.BOOL),ctypes.POINTER(ctypes.c_void_p),ctypes.POINTER(wintypes.BOOL)]
        get_acl.restype=wintypes.BOOL
        def acl(path):
            needed=wintypes.DWORD();get(str(path.resolve()),4,None,0,ctypes.byref(needed))
            buffer=ctypes.create_string_buffer(needed.value)
            self.assertTrue(get(str(path.resolve()),4,buffer,needed.value,ctypes.byref(needed)))
            present=wintypes.BOOL();defaulted=wintypes.BOOL();pointer=ctypes.c_void_p()
            self.assertTrue(get_acl(buffer,ctypes.byref(present),ctypes.byref(pointer),ctypes.byref(defaulted)))
            self.assertTrue(present.value and pointer.value)
            size=ctypes.c_ushort.from_address(pointer.value+2).value
            return ctypes.string_at(pointer.value,size)
        # Use an ordinary workspace directory, not the owner-only tempfile
        # fixture: otherwise both baseline and output have the same narrow ACL.
        from uuid import uuid4
        import shutil
        directory=self.previous/('.cog-acl-test-'+uuid4().hex)
        directory.mkdir();previous=Path.cwd()
        try:
            (directory/'source.tif').write_bytes(self.source.read_bytes())
            os.chdir(directory)
            self.convert('acl.tif',driver='COG',overviews=[2,4,8])
            self.assertEqual(acl(Path('acl.tif')),acl(self.source))
        finally:
            os.chdir(previous);shutil.rmtree(directory)

if __name__=='__main__':unittest.main()
