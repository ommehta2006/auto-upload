import ejs from 'ejs';
import path from 'node:path';
const root=process.cwd();
const base={
  csrfToken:'test-token',flash:null,title:'Test',
  currentUser:{id:'u1',displayName:'Creator',email:'creator@example.test'},
  appLimits:{maxVideoBytes:1073741824,maxImageBytes:10485760,maxCaptionBytes:5242880,maxExcelBytes:10485760,maxStorageBytesPerUser:2147483648},
  formatDate:(v)=>v?new Date(v).toISOString():'—',formatBytes:(b)=>`${b} B`
};
const settings={timezone:'Asia/Kolkata',default_visibility:'PRIVATE',default_audience:'NOT_MADE_FOR_KIDS',default_category:'22',default_language:'English',automation_enabled:true,maximum_uploads_per_day:3,minimum_gap_minutes:20,max_attempts:3,retry_delay_minutes:30,upload_window_start:'00:00',upload_window_end:'23:59'};
const item={id:'p1',upload_id:'VID-001',content_type:'VIDEO',media_id:'m1',thumbnail_id:null,caption_file_id:null,media_file_hint:'demo.mp4',title:'Demo',description:'Description',tags:'demo',playlist_name:'',visibility:'PRIVATE',youtube_publish_at:null,premiere:false,audience:'NOT_MADE_FOR_KIDS',age_restriction:false,paid_promotion:false,altered_content:false,automatic_chapters:true,featured_places:true,automatic_concepts:true,language:'English',caption_certification:'NONE',caption_language:'',caption_name:'',recording_date:null,recording_location:'',license:'STANDARD',distribution:'EVERYWHERE',allow_embedding:true,notify_subscribers:true,category:'22',comments_mode:'ALLOW_ALL',comments_sort:'TOP',show_like_count:true,remix_mode:'VIDEO_AND_AUDIO',related_video:'',enabled:true,status:'READY',error:'',warnings:[],automation_start_at:new Date(),media_name:'demo.mp4',media_size:1000,thumbnail_name:null,caption_name_file:null,youtube_url:null};
const media=[{id:'m1',kind:'VIDEO',original_name:'demo.mp4',size_bytes:1000,created_at:new Date()}];
const cases=[
 ['login.ejs',{...base,currentUser:null,title:'Sign in'}],
 ['register.ejs',{...base,currentUser:null,title:'Register',inviteRequired:true}],
 ['error.ejs',{...base,currentUser:null,title:'Error',message:'Example'}],
 ['youtube-connect.ejs',{...base,title:'Connect',session:{expiresAt:Date.now()+60000,remoteUrl:'/remote/vnc.html'}}],
 ['dashboard.ejs',{...base,title:'Dashboard',user:base.currentUser,settings,account:null,media,uploads:[item],logs:[{level:'success',message:'Created',created_at:new Date()}],counts:{total:1,videos:1,shorts:0,ready:1,uploaded:0,attention:0},storageUsedBytes:1000,loginSession:{active:false}}],
 ['edit-upload.ejs',{...base,title:'Edit',item,media,settings,automationDate:'2026-08-01',automationTime:'10:00',publishDate:'',publishTime:''}]
];
for (const [file,data] of cases){
  const html=await ejs.renderFile(path.join(root,'views',file),data);
  if (!html.toLowerCase().includes('<!doctype html>') || html.length<500) throw new Error(`Bad render: ${file}`);
  console.log(`${file}: ${html.length} bytes`);
}
