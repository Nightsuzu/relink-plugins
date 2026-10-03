// Isolated Windows SMTC bridge. No process injection, global media keys or player cookies.
#include <windows.h>
#include <tlhelp32.h>
#include <wincrypt.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Media.Control.h>
#include <winrt/Windows.Media.h>
#include <winrt/Windows.Storage.Streams.h>
#include <winrt/Windows.Graphics.Imaging.h>
#include <algorithm>
#include <chrono>
#include <iostream>
#include <map>
#include <string>
using namespace std::chrono_literals;
using namespace winrt::Windows::Data::Json;
using namespace winrt::Windows::Media::Control;
using Session = GlobalSystemMediaTransportControlsSession;
using Status = GlobalSystemMediaTransportControlsSessionPlaybackStatus;
using namespace winrt::Windows::Storage::Streams;
using namespace winrt::Windows::Graphics::Imaging;
auto str(std::wstring v){ return JsonValue::CreateStringValue(v); }
auto num(double v){ return JsonValue::CreateNumberValue(v); }
auto boolean(bool v){ return JsonValue::CreateBooleanValue(v); }
template<class T> auto await(T const& task){
 if(task.wait_for(1000ms)!=winrt::Windows::Foundation::AsyncStatus::Completed){task.Cancel();throw std::runtime_error("timeout");}
 return task.GetResults();
}
std::wstring clean(winrt::hstring const& v, size_t max=160){std::wstring s(v);s.erase(std::remove_if(s.begin(),s.end(),[](wchar_t c){return c<32||c==127;}),s.end());return s.substr(0,max);}
std::wstring app(std::wstring id){
 std::transform(id.begin(),id.end(),id.begin(),::towlower);
 if(id==L"qqmusic"||id==L"qqmusic.exe")return L"qqmusic";
 if(id==L"cloudmusic"||id==L"cloudmusic.exe")return L"netease";
 if(id==L"soda"||id==L"soda.exe"||id==L"sodamusic"||id==L"sodamusic.exe")return L"soda";
 return L"";
}
std::wstring art(GlobalSystemMediaTransportControlsSessionMediaProperties const& p){
 try{
  if(!p.Thumbnail())return L"";
  auto input=await(p.Thumbnail().OpenReadAsync()); if(input.Size()>4*1024*1024)return L"";
  auto decoder=await(BitmapDecoder::CreateAsync(input));
  if(!decoder.PixelWidth()||!decoder.PixelHeight()||decoder.PixelWidth()>4096||decoder.PixelHeight()>4096)return L"";
  BitmapTransform transform; const double scale=std::min(1.,160./std::max(decoder.PixelWidth(),decoder.PixelHeight()));
  const auto w=std::max(1u,static_cast<unsigned>(decoder.PixelWidth()*scale)),h=std::max(1u,static_cast<unsigned>(decoder.PixelHeight()*scale));
  transform.ScaledWidth(w);transform.ScaledHeight(h);
  auto pixels=await(decoder.GetPixelDataAsync(BitmapPixelFormat::Bgra8,BitmapAlphaMode::Premultiplied,transform,ExifOrientationMode::IgnoreExifOrientation,ColorManagementMode::DoNotColorManage)).DetachPixelData();
  InMemoryRandomAccessStream output; auto encoder=await(BitmapEncoder::CreateAsync(BitmapEncoder::PngEncoderId(),output));
  encoder.SetPixelData(BitmapPixelFormat::Bgra8,BitmapAlphaMode::Premultiplied,w,h,96,96,pixels);await(encoder.FlushAsync());
  if(output.Size()>160*1024)return L"";
  auto reader=DataReader(output.GetInputStreamAt(0));await(reader.LoadAsync(static_cast<unsigned>(output.Size())));
  std::vector<unsigned char> bytes(static_cast<size_t>(output.Size()));reader.ReadBytes(bytes);
  DWORD len=0;CryptBinaryToStringW(bytes.data(),static_cast<DWORD>(bytes.size()),CRYPT_STRING_BASE64|CRYPT_STRING_NOCRLF,nullptr,&len);
  std::wstring result(len,L'\0');if(!CryptBinaryToStringW(bytes.data(),static_cast<DWORD>(bytes.size()),CRYPT_STRING_BASE64|CRYPT_STRING_NOCRLF,result.data(),&len))return L"";
  result.resize(len);return L"data:image/png;base64,"+result;
 }catch(...){return L"";}
}
struct Entry{Session session{nullptr};std::wstring source,track,cover;};
JsonArray players(){
 static JsonArray cached;static auto last=std::chrono::steady_clock::time_point{};
 const auto now=std::chrono::steady_clock::now();if(now-last<1000ms)return cached;
 HANDLE snap=CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0);if(snap==INVALID_HANDLE_VALUE)return cached;
 std::map<std::wstring,double> first;PROCESSENTRY32W p{};p.dwSize=sizeof(p);
 if(Process32FirstW(snap,&p))do{
  const auto source=app(p.szExeFile);if(source.empty())continue;
  HANDLE process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,p.th32ProcessID);if(!process)continue;
  FILETIME start,exit,kernel,user;
  if(GetProcessTimes(process,&start,&exit,&kernel,&user)){
   ULARGE_INTEGER stamp;stamp.LowPart=start.dwLowDateTime;stamp.HighPart=start.dwHighDateTime;
   const double ms=static_cast<double>(stamp.QuadPart/10000);auto it=first.find(source);
   if(it==first.end()||ms<it->second)first[source]=ms;
  }CloseHandle(process);
 }while(Process32NextW(snap,&p));CloseHandle(snap);
 JsonArray rows;for(const auto& [source,started]:first){JsonObject row;row.Insert(L"source",str(source));row.Insert(L"started",num(started));rows.Append(row);}cached=rows;last=now;return rows;
}
// The hook only queues button-down points. Pipe I/O happens outside the hook,
// and every input is passed on unchanged to the game/application.
constexpr UINT PointerDownMessage = WM_APP + 1;
LRESULT CALLBACK pointerHook(int code, WPARAM message, LPARAM data) {
 if(code>=0 && (message==WM_LBUTTONDOWN||message==WM_RBUTTONDOWN||message==WM_MBUTTONDOWN||message==WM_XBUTTONDOWN)) {
  const auto point=reinterpret_cast<MSLLHOOKSTRUCT*>(data)->pt;
  PostThreadMessageW(GetCurrentThreadId(),PointerDownMessage,static_cast<WPARAM>(point.x),static_cast<LPARAM>(point.y));
 }
 return CallNextHookEx(nullptr,code,message,data);
}
int watchPointer(DWORD parentId) {
 HANDLE parent=OpenProcess(SYNCHRONIZE,FALSE,parentId);if(!parent)return 2;
 MSG message{};PeekMessageW(&message,nullptr,0,0,PM_NOREMOVE);
 const auto hook=SetWindowsHookExW(WH_MOUSE_LL,pointerHook,GetModuleHandleW(nullptr),0);
 if(!hook){CloseHandle(parent);return 3;}
 const auto timer=SetTimer(nullptr,0,1000,nullptr);
 std::cout<<"READY"<<std::endl;
 while(GetMessageW(&message,nullptr,0,0)>0) {
  if(message.message==WM_TIMER&&WaitForSingleObject(parent,0)!=WAIT_TIMEOUT)break;
  if(message.message==PointerDownMessage)std::cout<<"DOWN "<<static_cast<LONG>(message.wParam)<<" "<<static_cast<LONG>(message.lParam)<<std::endl;
  if(!std::cout.good())break;
 }
 KillTimer(nullptr,timer);UnhookWindowsHookEx(hook);CloseHandle(parent);return 0;
}
int main(int argc,char** argv){
 if(argc==3&&std::string(argv[1])=="--pointer-watch")return watchPointer(static_cast<DWORD>(std::stoul(argv[2])));
 winrt::init_apartment(winrt::apartment_type::multi_threaded);
 GlobalSystemMediaTransportControlsSessionManager manager{nullptr};std::map<std::wstring,Entry> entries;unsigned serial=0;
 // Fixed request size prevents a malformed parent from allocating an unbounded line.
 char line[16384];while(std::cin.getline(line,sizeof(line))){JsonObject reply;double id=0;
  try{
   auto request=JsonObject::Parse(winrt::to_hstring(line));id=request.GetNamedNumber(L"id");
   if(!manager)manager=await(GlobalSystemMediaTransportControlsSessionManager::RequestAsync());
   const auto op=request.GetNamedString(L"op");
   if(op==L"state"){
    reply.Insert(L"players",players());
    JsonArray rows;std::map<std::wstring,Entry> next;unsigned examined=0;
    for(auto const& s:manager.GetSessions()){
     if(++examined>24||rows.Size()>=6)break;const auto source=app(std::wstring(s.SourceAppUserModelId()));if(source.empty())continue;
     try{
      auto p=await(s.TryGetMediaPropertiesAsync());if(p.Title().empty())continue;
      const auto track=clean(p.Title())+L"\x1f"+clean(p.Artist())+L"\x1f"+clean(p.AlbumTitle());
      std::wstring key;for(auto const& [k,e]:entries)if(e.session==s){key=k;break;}
      if(key.empty())key=L"media-"+std::to_wstring(++serial);
      Entry e{s,source,track,L""};auto old=entries.find(key);e.cover=old!=entries.end()&&old->second.track==track?old->second.cover:art(p);
      const auto info=s.GetPlaybackInfo();auto controls=info.Controls();const auto time=s.GetTimelineProperties();
      const auto duration=std::clamp<int64_t>((time.EndTime()-time.StartTime()).count()/10000,0,86400000);
      auto position=std::max<int64_t>(0,(time.Position()-time.StartTime()).count()/10000);
      const bool playing=info.PlaybackStatus()==Status::Playing;
      const auto updated=time.LastUpdatedTime().time_since_epoch().count()/10000-11644473600000LL;
      const auto now=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
      if(playing&&updated>0)position+=std::clamp<int64_t>(now-updated,0,10000);
      JsonObject row,c;row.Insert(L"id",str(key));row.Insert(L"source",str(source));row.Insert(L"track",str(track));
      row.Insert(L"title",str(clean(p.Title())));row.Insert(L"artist",str(clean(p.Artist())));row.Insert(L"album",str(clean(p.AlbumTitle())));row.Insert(L"cover",str(e.cover));
      row.Insert(L"current",boolean(manager.GetCurrentSession()==s));row.Insert(L"playing",boolean(playing));row.Insert(L"durationMs",num(duration));row.Insert(L"positionMs",num(duration?std::min(position,duration):position));
      c.Insert(L"play",boolean(controls.IsPlayEnabled()));c.Insert(L"pause",boolean(controls.IsPauseEnabled()));c.Insert(L"next",boolean(controls.IsNextEnabled()));c.Insert(L"previous",boolean(controls.IsPreviousEnabled()));
      row.Insert(L"controls",c);rows.Append(row);next.emplace(key,std::move(e));
     }catch(...){/* One broken player must not hide the others. */}
    }entries=std::move(next);reply.Insert(L"sessions",rows);
   }else if(op==L"diagnostic"){
    JsonArray ids;for(const auto& session:manager.GetSessions())ids.Append(str(clean(session.SourceAppUserModelId(),240)));reply.Insert(L"appIds",ids);reply.Insert(L"players",players());
   }else if(op==L"control"){
    const auto found=entries.find(std::wstring(request.GetNamedString(L"session")));if(found==entries.end())throw std::runtime_error("missing session");
    auto& e=found->second;
    const auto action=request.GetNamedString(L"action");const auto c=e.session.GetPlaybackInfo().Controls();bool ok=false;
    if(action==L"play"&&c.IsPlayEnabled())ok=await(e.session.TryPlayAsync());
    else if(action==L"pause"&&c.IsPauseEnabled())ok=await(e.session.TryPauseAsync());
    else if(action==L"next"&&c.IsNextEnabled())ok=await(e.session.TrySkipNextAsync());
    else if(action==L"previous"&&c.IsPreviousEnabled())ok=await(e.session.TrySkipPreviousAsync());
    if(!ok)throw std::runtime_error("unsupported or refused");
   }else throw std::runtime_error("operation");
   reply.Insert(L"ok",boolean(true));
  }catch(...){reply.Insert(L"ok",boolean(false));reply.Insert(L"error",str(L"播放器未响应或状态已改变"));}
  reply.Insert(L"id",num(id));std::cout<<winrt::to_string(reply.Stringify())<<std::endl;
 }
}
