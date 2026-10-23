<?php
namespace App\Providers;
use Illuminate\Support\Facades\Route;
class RouteServiceProvider
{
    protected $namespace = 'App\Http\Controllers';

    /** 注册示例 API 路由。 */
    public function map()
    {
        $this->mapApiRoutes();
    }

    /** 将路由文件挂载到统一前缀及命名空间下。 */
    protected function mapApiRoutes()
    {
        Route::prefix('api')->namespace($this->namespace)->group(base_path('routes/api.php'));
    }
}
